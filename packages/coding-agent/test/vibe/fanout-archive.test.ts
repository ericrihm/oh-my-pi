import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	type FanoutArchiveManager,
	type FanoutArchiveReservation,
	type FanoutPreflightRequest,
	FanoutStoragePreflightError,
} from "@oh-my-pi/pi-coding-agent/session/fanout-archive";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";

interface RecordingReservation extends FanoutArchiveReservation {
	claimedChildren: number;
	releasedChildren: number;
	settledChildren: number;
}

function recordingReservation(): RecordingReservation {
	const reservation: RecordingReservation = {
		parentArtifactsDir: "/tmp",
		claimedChildren: 0,
		releasedChildren: 0,
		settledChildren: 0,
		claimChild: async () => {
			reservation.claimedChildren += 1;
		},
		releaseUnclaimedChild: () => {
			reservation.releasedChildren += 1;
		},
		settleChild: () => {
			reservation.settledChildren += 1;
		},
		cancel: () => {},
	};
	return reservation;
}

function resultFor(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "sonic",
		agentSource: "bundled",
		task: "work",
		assignment: "work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

describe("Vibe fanout archive lifecycle", () => {
	const managers: AsyncJobManager[] = [];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		VibeSessionRegistry.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1_000 });
		VibeSessionRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("releases Vibe's unclaimed reservation when scheduling fails before child allocation", async () => {
		const reservation = recordingReservation();
		const archive = {
			preflight: vi.fn(async (_request: FanoutPreflightRequest) => reservation),
		} as unknown as FanoutArchiveManager;
		const session = {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => "/tmp/vibe-parent.jsonl",
			getSessionId: () => "parent",
			getAgentId: () => "Main",
			getSessionSpawns: () => "*",
			getFanoutArchiveManager: () => archive,
		} as unknown as ToolSession;

		await expect(
			VibeSessionRegistry.global().spawn(session, {
				cli: "fast",
				name: "Dead",
				prompt: "work",
			}),
		).rejects.toThrow("Vibe sessions require async execution");
		expect(archive.preflight).toHaveBeenCalledTimes(1);
		expect(reservation.claimedChildren).toBe(0);
		expect(reservation.releasedChildren).toBe(1);
		expect(reservation.settledChildren).toBe(0);
	});
	it("rejects 24 Vibe spawns before output allocation or job registration when admission has no headroom", async () => {
		const archive = {
			preflight: vi.fn(async () => {
				throw new FanoutStoragePreflightError(
					"physical-space",
					"Fanout storage preflight rejected 1 children: physical free gained: 0 B",
				);
			}),
		} as unknown as FanoutArchiveManager;
		const allocate = vi.fn(async (name: string) => name);
		const session = {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => "/tmp/vibe-parent.jsonl",
			getSessionId: () => "parent",
			getAgentId: () => "Main",
			getSessionSpawns: () => "*",
			getFanoutArchiveManager: () => archive,
			agentOutputManager: { allocate },
		} as unknown as ToolSession;

		for (let index = 0; index < 24; index += 1) {
			await expect(
				VibeSessionRegistry.global().spawn(session, {
					cli: "fast",
					name: `Rejected${index}`,
					prompt: "work",
				}),
			).rejects.toThrow("Fanout storage preflight rejected");
		}

		expect(archive.preflight).toHaveBeenCalledTimes(24);
		expect(allocate).not.toHaveBeenCalled();
	});

	it("settles a claimed Vibe reservation once when cancellation races first-turn startup", async () => {
		using temp = TempDir.createSync("@omp-vibe-fanout-race-");
		const reservation = recordingReservation();
		const claimStarted = Promise.withResolvers<void>();
		const claimResolved = Promise.withResolvers<void>();
		reservation.claimChild = async () => {
			reservation.claimedChildren += 1;
			claimStarted.resolve();
			await claimResolved.promise;
		};
		const archive = {
			preflight: vi.fn(async () => reservation),
			archiveTerminalChildren: vi.fn(async () => {}),
			resolveArchivedTranscript: vi.fn(async () => undefined),
		} as unknown as FanoutArchiveManager;
		const entries: Array<{
			type: "custom";
			customType: string;
			data: unknown;
		}> = [];
		const jobs = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(jobs);
		const cancellation = Promise.withResolvers<void>();
		const cancel = jobs.cancel.bind(jobs);
		vi.spyOn(jobs, "cancel").mockImplementation((...args) => {
			const cancelled = cancel(...args);
			cancellation.resolve();
			return cancelled;
		});
		const session = {
			cwd: temp.path(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => temp.join("parent.jsonl"),
			getSessionId: () => "parent",
			getAgentId: () => "Main",
			getSessionSpawns: () => "*",
			getFanoutArchiveManager: () => archive,
			asyncJobManager: jobs,
			agentOutputManager: {
				reserve: async () => {},
				allocate: async () => "Racing",
			},
			sessionManager: {
				ensureOnDisk: async () => {},
				appendCustomEntry: (customType: string, data: unknown) =>
					entries.push({ type: "custom", customType, data }),
				flush: async () => {},
				getEntries: () => entries,
				getBranch: () => entries,
			},
		} as unknown as ToolSession;
		const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => {
			throw new Error("cancelled startup must not launch a subprocess");
		});

		const spawned = await VibeSessionRegistry.global().spawn(session, {
			cli: "fast",
			name: "Racing",
			prompt: "work",
		});
		await claimStarted.promise;
		const killing = VibeSessionRegistry.global().kill(session, spawned.id);
		await cancellation.promise;
		claimResolved.resolve();
		await killing;
		await jobs.getJob(spawned.jobId)!.promise.catch(() => {});

		expect(runSubprocess).not.toHaveBeenCalled();
		expect(reservation.claimedChildren).toBe(1);
		expect(reservation.releasedChildren).toBe(0);
		expect(reservation.settledChildren).toBe(1);
	});

	it("preflights Vibe before ID/job creation and archives only after a durable terminal sidecar seals the child", async () => {
		using temp = TempDir.createSync("@omp-vibe-fanout-archive-");
		const parentSessionFile = temp.join("parent.jsonl");
		const artifactsDir = parentSessionFile.slice(0, -6);
		await fs.mkdir(artifactsDir, { recursive: true });
		const reservation = recordingReservation();
		const lifecycle = [] as string[];
		const archiveDrained = Promise.withResolvers<void>();
		let childId = "Dead";
		const archived = false;
		let archiveSawSealedChild = false;
		const archive = {
			preflight: vi.fn(async (_request: FanoutPreflightRequest) => {
				lifecycle.push("preflight");
				return reservation;
			}),
			archiveTerminalChildren: vi.fn(async () => {
				archiveSawSealedChild = await fs
					.access(path.join(artifactsDir, `${childId}.jsonl.tombstone`))
					.then(() => true)
					.catch(() => false);
				archiveDrained.resolve();
			}),
			resolveArchivedTranscript: vi.fn(async () =>
				archived ? path.join(".fanout-archive", "entries", childId, `${childId}.jsonl`) : undefined,
			),
		} as unknown as FanoutArchiveManager;
		const entries: Array<{
			type: "custom";
			customType: string;
			data: unknown;
		}> = [];
		const jobs = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(jobs);
		const session = {
			cwd: temp.path(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => parentSessionFile,
			getSessionId: () => "parent",
			getAgentId: () => "Main",
			getSessionSpawns: () => "*",
			getArtifactsDir: () => artifactsDir,
			getFanoutArchiveManager: () => archive,
			asyncJobManager: jobs,
			agentOutputManager: {
				reserve: async () => lifecycle.push("reserve"),
				allocate: async () => {
					lifecycle.push("allocate");
					return "Dead";
				},
			},
			sessionManager: {
				ensureOnDisk: async () => {},
				appendCustomEntry: (customType: string, data: unknown) =>
					entries.push({ type: "custom", customType, data }),
				flush: async () => {},
				getEntries: () => entries,
				getBranch: () => entries,
			},
		} as unknown as ToolSession;
		const childTranscript = () => {
			const timestamp = new Date().toISOString();
			return [
				JSON.stringify({
					type: "session",
					version: 3,
					id: "child",
					timestamp,
					cwd: temp.path(),
				}),
				JSON.stringify({
					type: "session_init",
					id: "init",
					parentId: null,
					timestamp,
					systemPrompt: "test",
					task: "work",
					tools: [],
				}),
			].join("\n");
		};
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async (options: ExecutorOptions) => {
			const childSessionFile = path.join(options.artifactsDir!, `${options.id}.jsonl`);
			await fs.writeFile(childSessionFile, childTranscript());
			AgentRegistry.global().register({
				id: options.id!,
				displayName: options.id!,
				kind: "sub",
				parentId: "Main",
				session: null,
				sessionFile: childSessionFile,
				status: "idle",
			});
			return resultFor(options.id!);
		});

		const registry = VibeSessionRegistry.global();
		const spawned = await registry.spawn(session, {
			cli: "fast",
			name: "Dead",
			prompt: "work",
		});
		childId = spawned.id;
		await jobs.getJob(spawned.jobId)!.promise;

		expect(lifecycle.slice(0, 3)).toEqual(["preflight", "reserve", "allocate"]);
		expect(archive.preflight).toHaveBeenCalledWith(expect.objectContaining({ childCount: 1 }));
		expect(reservation.claimedChildren).toBe(1);
		expect(reservation.releasedChildren).toBe(0);
		expect(reservation.settledChildren).toBe(1);
		const childSessionFile = path.join(artifactsDir, `${childId}.jsonl`);
		await fs.writeFile(childSessionFile, childTranscript());
		const existing = AgentRegistry.global().get(childId);
		if (existing) AgentRegistry.global().unregister(childId, existing);
		AgentRegistry.global().register({
			id: childId,
			displayName: childId,
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: childSessionFile,
			status: "idle",
		});

		await registry.kill(session, childId);
		await archiveDrained.promise;
		expect(AgentRegistry.global().get(childId)?.status).toBe("aborted");
		expect(await fs.access(path.join(artifactsDir, `${childId}.jsonl.tombstone`)).then(() => true)).toBe(true);
		expect(archiveSawSealedChild).toBe(true);
		expect(archive.archiveTerminalChildren).toHaveBeenCalledTimes(1);

		AgentRegistry.resetGlobalForTests();
		VibeSessionRegistry.resetGlobalForTests();
		entries.push({
			type: "custom",
			customType: "vibe-session-lifecycle",
			data: {
				version: 1,
				action: "tombstone",
				id: "Missing",
				ownerId: "Main",
				parentSessionId: "parent",
				reason: "explicit-kill",
			},
		});
		expect(await VibeSessionRegistry.global().rehydrate(session)).toBe(0);
		expect(AgentRegistry.global().get(childId)?.status).toBe("aborted");
	});
});
