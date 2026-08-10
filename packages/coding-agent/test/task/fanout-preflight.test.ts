import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
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
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentOutputManager } from "@oh-my-pi/pi-coding-agent/task/output-manager";
import type { AgentDefinition, SingleResult, TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const MiB = 1024 * 1024;

interface PreflightRejectingArchive {
	createdPaths: string[];
	preflight(request: FanoutPreflightRequest): Promise<FanoutArchiveReservation>;
}

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

function acceptingArchive(reservation: RecordingReservation): FanoutArchiveManager {
	return {
		preflight: vi.fn().mockResolvedValue(reservation),
	} as unknown as FanoutArchiveManager;
}

function tasks(count: number): TaskParams {
	return {
		context: "shared",
		tasks: Array.from({ length: count }, (_, index) => ({
			name: `Child${index + 1}`,
			task: "Work.",
		})),
	} as TaskParams;
}

function twentyFourTasks(): TaskParams {
	return tasks(24);
}

function resultFor(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "prompt",
		assignment: "Work.",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

function preflightRejecting(kind: FanoutStoragePreflightError["kind"], details: string): PreflightRejectingArchive {
	return {
		createdPaths: [],
		preflight: vi
			.fn()
			.mockRejectedValue(
				new FanoutStoragePreflightError(kind, `Fanout storage preflight rejected 24 children: ${details}`),
			),
	};
}

describe("task fanout archive preflight", () => {
	const managers: AsyncJobManager[] = [];
	let sessionNumber = 0;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1_000 });
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	async function taskFixture(
		archive: FanoutArchiveManager,
		settings: Record<string, unknown> = {},
		persistent = true,
	) {
		const jobs = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(jobs);
		const outputManager = {
			allocate: vi.fn(async (name: string) => name),
		} as unknown as AgentOutputManager;
		const sessionFile = `/tmp/fanout-preflight-${++sessionNumber}.jsonl`;
		const session = {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({
				"async.enabled": true,
				"task.batch": true,
				...settings,
			}),
			getSessionFile: () => (persistent ? sessionFile : null),
			getSessionSpawns: () => "*",
			getFanoutArchiveManager: () => archive,
			asyncJobManager: jobs,
			agentOutputManager: outputManager,
		} as unknown as ToolSession;
		return { tool: await TaskTool.create(session), outputManager, jobs };
	}

	it.each([
		["physical-space", `physical free: ${820 * MiB} B; physical free gained: 0 B`],
		["cross-device", "parent artifacts and archive roots are on different filesystems"],
		["unsafe-recovery", "archive recovery requires manual intervention"],
		["active-terminal-limit", "strict active-terminal budget would be exceeded"],
		["archive-capacity", "archive capacity cannot retain the required terminal children"],
	] as const)(
		"rejects persistent batch before allocating IDs, artifact directories, or async jobs (%s)",
		async (kind, details) => {
			const archive = preflightRejecting(kind, details);
			const { tool, outputManager, jobs } = await taskFixture(archive as unknown as FanoutArchiveManager);
			const register = vi.spyOn(jobs, "register").mockImplementation(() => {
				throw new Error("unexpected job registration");
			});

			const result = await tool.execute("fanout", twentyFourTasks());

			expect(textOf(result)).toContain("Fanout storage preflight rejected 24 children:");
			expect(textOf(result)).toContain(details);
			expect(archive.preflight).toHaveBeenCalledTimes(1);
			expect(archive.preflight).toHaveBeenCalledWith(expect.objectContaining({ childCount: 24 }));
			expect(outputManager.allocate).not.toHaveBeenCalled();
			expect(register).not.toHaveBeenCalled();
			expect(archive.createdPaths).toEqual([]);
		},
	);

	it("fails closed when a persistent parent has no archive manager", async () => {
		const { tool, outputManager, jobs } = await taskFixture(undefined as unknown as FanoutArchiveManager);
		const register = vi.spyOn(jobs, "register").mockImplementation(() => {
			throw new Error("unexpected job registration");
		});

		const result = await tool.execute("fanout", {
			context: "shared",
			tasks: [{ name: "Child", task: "Work." }],
		} as TaskParams);

		expect(textOf(result)).toContain("Fanout storage preflight is unavailable for this persistent session");
		expect(outputManager.allocate).not.toHaveBeenCalled();
		expect(register).not.toHaveBeenCalled();
	});

	it("settles a claimed child when deferred output-ID allocation fails", async () => {
		let cancellations = 0;
		const reservation = recordingReservation();
		reservation.cancel = () => {
			cancellations += 1;
		};
		const { tool, outputManager, jobs } = await taskFixture(acceptingArchive(reservation));
		vi.spyOn(outputManager, "allocate").mockRejectedValue(new Error("allocation failed"));

		const result = await tool.execute("fanout", {
			context: "shared",
			tasks: [{ name: "Child", task: "Work." }],
		} as TaskParams);
		await jobs.getJob(result.details!.async!.jobId)!.promise;

		expect(cancellations).toBe(0);
		expect(reservation.claimedChildren).toBe(1);
		expect(reservation.releasedChildren).toBe(0);
		expect(reservation.settledChildren).toBe(1);
	});

	it("bypasses archive admission for a non-persistent parent", async () => {
		const archive = preflightRejecting("physical-space", "temporary parents do not reserve archive storage");
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => resultFor(options.id ?? "unknown"));
		const { tool } = await taskFixture(archive as unknown as FanoutArchiveManager, { "async.enabled": false }, false);

		await tool.execute("fanout", {
			context: "shared",
			tasks: [{ name: "Temporary", task: "Work." }],
		} as TaskParams);

		expect(archive.preflight).not.toHaveBeenCalled();
	});

	it("releases an unclaimed reservation when async scheduling fails", async () => {
		const reservation = recordingReservation();
		const { tool, jobs } = await taskFixture(acceptingArchive(reservation));
		vi.spyOn(jobs, "register").mockImplementation(() => {
			throw new Error("scheduling failed");
		});

		await tool.execute("fanout", {
			context: "shared",
			tasks: [{ name: "Child", task: "Work." }],
		} as TaskParams);

		expect(reservation.releasedChildren).toBe(1);
		expect(reservation.settledChildren).toBe(0);
	});

	it("defers async output ID allocation until the final claim and preserves the retry ID", async () => {
		const reservation = recordingReservation();
		let rejectClaim = true;
		reservation.claimChild = async () => {
			reservation.claimedChildren += 1;
			if (rejectClaim)
				throw new Error("Fanout storage preflight rejected 1 children: final free-space check failed");
		};
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => resultFor(options.id ?? "unknown"));
		const { tool, outputManager, jobs } = await taskFixture(acceptingArchive(reservation));

		const rejected = await tool.execute("fanout", {
			context: "shared",
			tasks: [{ name: "Child", task: "Work." }],
		} as TaskParams);
		const rejectedJob = jobs.getJob(rejected.details!.async!.jobId)!;
		await rejectedJob.promise;

		expect(outputManager.allocate).not.toHaveBeenCalled();
		expect(reservation.releasedChildren).toBe(1);
		expect(rejectedJob.errorText).not.toContain("is now idle");
		expect(rejectedJob.errorText).not.toContain("history://");
		expect(rejectedJob.errorText).not.toContain("DM `");

		rejectClaim = false;
		const retried = await tool.execute("fanout", {
			context: "shared",
			tasks: [{ name: "Child", task: "Work." }],
		} as TaskParams);
		await jobs.getJob(retried.details!.async!.jobId)!.promise;

		expect(outputManager.allocate).toHaveBeenCalledTimes(1);
		expect(outputManager.allocate).toHaveBeenLastCalledWith("Child");
		expect(reservation.settledChildren).toBe(1);
	});

	it("binds repeated persistent async jobs to their post-claim child IDs", async () => {
		const reservation = recordingReservation();
		const { tool, outputManager, jobs } = await taskFixture(acceptingArchive(reservation));
		let allocations = 0;
		vi.spyOn(outputManager, "allocate").mockImplementation(async name => {
			allocations += 1;
			return allocations === 1 ? name : `${name}-2`;
		});
		const dispatched: string[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options.id ?? "missing");
			return resultFor(options.id ?? "missing");
		});

		const first = await tool.execute("fanout", {
			context: "shared",
			tasks: [{ name: "Child", task: "Work." }],
		} as TaskParams);
		const firstJob = jobs.getJob(first.details!.async!.jobId)!;
		await firstJob.promise;
		const second = await tool.execute("fanout", {
			context: "shared",
			tasks: [{ name: "Child", task: "Work." }],
		} as TaskParams);
		const secondJob = jobs.getJob(second.details!.async!.jobId)!;
		await secondJob.promise;

		expect(dispatched).toEqual(["Child", "Child-2"]);
		expect(firstJob.agentId).toBe("Child");
		expect(secondJob.agentId).toBe("Child-2");
	});

	it("does not advertise a provisional ID for coordination and binds the job during persistent startup", async () => {
		const reservation = recordingReservation();
		const { tool, outputManager, jobs } = await taskFixture(acceptingArchive(reservation));
		vi.spyOn(outputManager, "allocate").mockResolvedValue("Child");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			await options.onProgress?.({
				id: options.id,
				recentTools: [],
				recentOutput: [],
			} as never);
			started.resolve();
			await release.promise;
			return resultFor(options.id ?? "missing");
		});

		const spawned = await tool.execute("fanout", {
			context: "shared",
			tasks: [{ name: "Child", task: "Work." }],
		} as TaskParams);
		const job = jobs.getJob(spawned.details!.async!.jobId)!;
		await started.promise;

		expect(textOf(spawned)).not.toContain("DM `pending-");
		expect(job.agentId).toBe("Child");

		release.resolve();
		await job.promise;
	});

	it("claims each synchronous child and settles it exactly once", async () => {
		const reservation = recordingReservation();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => resultFor(options.id ?? "unknown"));
		const { tool } = await taskFixture(acceptingArchive(reservation), {
			"async.enabled": false,
		});

		await tool.execute("fanout", {
			context: "shared",
			tasks: [
				{ name: "First", task: "Work A." },
				{ name: "Second", task: "Work B." },
			],
		} as TaskParams);

		expect(reservation.releasedChildren).toBe(0);
		expect(reservation.claimedChildren).toBe(2);
		expect(reservation.settledChildren).toBe(2);
	});

	it("releases a cancelled queued async child and settles its started sibling", async () => {
		const reservation = recordingReservation();
		const gates = new Map<string, PromiseWithResolvers<void>>();
		const started = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "unknown";
			if (id === "First") started.resolve();
			const gate = Promise.withResolvers<void>();
			gates.set(id, gate);
			await gate.promise;
			return resultFor(id);
		});
		const { tool, jobs } = await taskFixture(acceptingArchive(reservation), {
			"task.maxConcurrency": 1,
		});

		await tool.execute("fanout", {
			context: "shared",
			tasks: [
				{ name: "First", task: "Work A." },
				{ name: "Second", task: "Work B." },
			],
		} as TaskParams);

		const [first, second] = jobs.getAllJobs();
		if (!first || !second) throw new Error("Expected two queued task jobs");
		await started.promise;
		expect(jobs.cancel(second.id)).toBe(true);
		await second.promise;
		gates.get("First")!.resolve();
		await first.promise;

		expect(reservation.releasedChildren).toBe(1);
		expect(reservation.settledChildren).toBe(1);
	});
	it("bounds 25 persistent children at the 24-child concurrency limit without duplicate settlement", async () => {
		const reservation = recordingReservation();
		const reservationsSettled = Promise.withResolvers<void>();
		const settleChild = reservation.settleChild;
		reservation.settleChild = () => {
			settleChild();
			if (reservation.settledChildren === 25) reservationsSettled.resolve();
		};
		const firstWave = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		let running = 0;
		let peakRunning = 0;
		let started = 0;
		let settled = 0;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			started += 1;
			running += 1;
			peakRunning = Math.max(peakRunning, running);
			if (started === 24) firstWave.resolve();
			await release.promise;
			running -= 1;
			settled += 1;
			if (settled === 25) completed.resolve();
			return resultFor(options.id ?? "unknown");
		});
		const { tool } = await taskFixture(acceptingArchive(reservation), {
			"task.maxConcurrency": 24,
		});

		await tool.execute("fanout", tasks(25));
		await firstWave.promise;

		expect(peakRunning).toBe(24);
		expect(started).toBe(24);
		release.resolve();
		await reservationsSettled.promise;
		expect(reservation.claimedChildren).toBe(25);
		expect(reservation.settledChildren).toBe(25);
		expect(reservation.releasedChildren).toBe(0);
	});
});
