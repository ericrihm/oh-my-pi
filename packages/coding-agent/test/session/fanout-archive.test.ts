import { describe, expect, it } from "bun:test";
import {
	appendFile,
	link,
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	type FanoutArchiveDependencies,
	FanoutArchiveManager,
	fanoutArchiveSettings,
} from "@oh-my-pi/pi-coding-agent/session/fanout-archive";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const TERMINAL_EPOCH_MS = 1_700_000_000_000;

async function parentFixture(tempPath: string) {
	const parentArtifactsDir = path.join(tempPath, "parent");
	const liveness = new Map<
		string,
		FanoutArchiveDependencies["childLiveness"] extends (id: string) => infer T ? T : never
	>();
	const revivable = new Set<string>();
	const changing = new Set<string>();
	const publishedOrder: string[] = [];
	let failAt: string | undefined;
	const copyCalls = 0;
	const unlinkCallsForData = 0;
	const operations: string[] = [];
	const barrierActions = new Map<string, () => Promise<void> | void>();
	await mkdir(parentArtifactsDir);

	const writeChild = async (
		id: string,
		options: {
			status?: "running" | "idle" | "parked" | "aborted";
			terminalAt: number;
			spills?: readonly string[];
			transcript?: string;
			sessionFile?: string;
		},
	) => {
		const transcriptPath = path.join(parentArtifactsDir, `${id}.jsonl`);
		const spills = options.spills ?? [];
		await writeFile(
			transcriptPath,
			options.transcript ??
				`${JSON.stringify({
					type: "message",
					message: {
						role: "toolResult",
						isError: false,
						details: {
							meta: { truncation: { artifactId: spills[0]?.split(".", 1)[0] } },
						},
					},
				})}\n`,
		);
		await writeFile(`${transcriptPath}.tombstone`, "");
		for (const spill of spills) await writeFile(path.join(parentArtifactsDir, spill), `${id}:${spill}`);
		await utimes(transcriptPath, TERMINAL_EPOCH_MS / 1_000, (TERMINAL_EPOCH_MS + options.terminalAt) / 1_000);
		await utimes(
			`${transcriptPath}.tombstone`,
			TERMINAL_EPOCH_MS / 1_000,
			(TERMINAL_EPOCH_MS + options.terminalAt) / 1_000,
		);
		liveness.set(id, {
			status: options.status ?? "aborted",
			sessionFile: options.sessionFile ?? transcriptPath,
		});
	};

	const archiveEntriesDir = path.join(parentArtifactsDir, ".fanout-archive", "entries");
	const dependencies: FanoutArchiveDependencies = {
		fs: {
			stat,
			lstat,
			statfs: async () => ({ bavail: 1_000_000, bsize: 1 }),
			readdir,
			readFile: async file => {
				const contents = await readFile(file);
				if (changing.delete(file)) await appendFile(file, " ");
				return contents;
			},
			writeFile: async (file, data, options) => {
				operations.push(`write:${path.basename(file)}`);
				await writeFile(file, data, options);
			},
			mkdir: async (directory, options) => {
				await mkdir(directory, options);
			},
			rename: async (from, to) => {
				operations.push(`rename:${path.basename(from)}:${path.basename(to)}`);
				await rename(from, to);
				if (path.dirname(to) === archiveEntriesDir && path.dirname(from) !== archiveEntriesDir) {
					publishedOrder.push(path.basename(to));
				}
			},
			renameNoReplace: async (from, to) => {
				try {
					await lstat(to);
					const error = Object.assign(new Error(`Destination exists: ${to}`), {
						code: "EEXIST",
					});
					throw error;
				} catch (error) {
					if (!("code" in (error as object)) || (error as { code?: unknown }).code !== "ENOENT") throw error;
				}
				operations.push(`rename-no-replace:${path.basename(from)}:${path.basename(to)}`);
				await rename(from, to);
				if (path.dirname(to) === archiveEntriesDir && path.dirname(from) !== archiveEntriesDir) {
					publishedOrder.push(path.basename(to));
				}
			},
			sync: async file => {
				operations.push(`sync:${path.basename(file)}`);
			},
			removeJournal: async file => rm(file),
		},
		barrier: async point => {
			await barrierActions.get(point)?.();
			if (point === failAt) throw new Error(`Injected interruption at ${point}`);
		},
		now: () => TERMINAL_EPOCH_MS + 100,
		childLiveness: id => liveness.get(id),
		isVibeRevivable: id => revivable.has(id),
	};

	return {
		parentArtifactsDir,
		writeChild,
		revivable,
		liveness,
		changing,
		archiveEntriesDir,
		manager: (archiveLimitBytes: number) =>
			FanoutArchiveManager.forParent(parentArtifactsDir, {
				...dependencies,
				archiveSettings: {
					enabled: true,
					archiveLimitBytes,
					minimumFreeBytes: 0,
					reserveBytesPerChild: 0,
					strictActiveTerminalLimitBytes: 0,
				},
			}),
		activeFiles: async () => readdir(parentArtifactsDir),
		publishedIds: async () => [...publishedOrder],
		bytesOf: async (id: string) => {
			const names = [`${id}.jsonl`, `${id}.jsonl.tombstone`];
			const transcript = JSON.parse(await readFile(path.join(parentArtifactsDir, `${id}.jsonl`), "utf8")) as {
				message?: {
					details?: { meta?: { truncation?: { artifactId?: string } } };
				};
			};
			const artifactId = transcript.message?.details?.meta?.truncation?.artifactId;
			if (artifactId && /^\d+$/.test(artifactId)) {
				const [spill] = (await readdir(parentArtifactsDir)).filter(name => name.startsWith(`${artifactId}.`));
				if (spill) names.push(spill);
			}
			return Promise.all(names.map(async name => (await stat(path.join(parentArtifactsDir, name))).size)).then(
				sizes => sizes.reduce((total, size) => total + size, 0),
			);
		},
		bytesOfPublishedEntries: async () => {
			const ids = await readdir(archiveEntriesDir);
			return (
				await Promise.all(
					ids.map(async id => {
						try {
							const manifest = JSON.parse(
								await readFile(path.join(archiveEntriesDir, id, "manifest.json"), "utf8"),
							) as { id?: string; bytes?: number };
							return manifest.id === id && typeof manifest.bytes === "number" ? manifest.bytes : 0;
						} catch {
							return 0;
						}
					}),
				)
			).reduce((total, bytes) => total + bytes, 0);
		},
		files: {
			failAt: (point: string | undefined) => {
				failAt = point;
			},
			get copyCalls() {
				return copyCalls;
			},
			get unlinkCallsForData() {
				return unlinkCallsForData;
			},
			barrier: (point: string, action: () => Promise<void> | void) => {
				barrierActions.set(point, action);
			},
			operations,
		},
		restartManager: (archiveLimitBytes: number) =>
			FanoutArchiveManager.forParent(
				parentArtifactsDir,
				{
					...dependencies,
					archiveSettings: {
						enabled: true,
						archiveLimitBytes,
						minimumFreeBytes: 0,
						reserveBytesPerChild: 0,
						strictActiveTerminalLimitBytes: 0,
					},
				},
				{ fresh: true },
			),
		hasOnlyCompleteActiveOrPublishedEntry: async (id: string) => {
			const activePaths = [
				path.join(parentArtifactsDir, `${id}.jsonl`),
				path.join(parentArtifactsDir, `${id}.jsonl.tombstone`),
				path.join(parentArtifactsDir, "17.bash.log"),
			];
			const filesExist = async (files: readonly string[]) =>
				(
					await Promise.all(
						files.map(async file => {
							try {
								await lstat(file);
								return true;
							} catch {
								return false;
							}
						}),
					)
				).every(Boolean);
			const active = await filesExist(activePaths);
			let published = false;
			try {
				const entryDir = path.join(archiveEntriesDir, id);
				const manifest = JSON.parse(await readFile(path.join(entryDir, "manifest.json"), "utf8")) as {
					id?: unknown;
					transcript?: unknown;
					tombstone?: unknown;
					spills?: unknown;
				};
				published =
					manifest.id === id &&
					manifest.transcript === `${id}.jsonl` &&
					manifest.tombstone === `${id}.jsonl.tombstone` &&
					JSON.stringify(manifest.spills) === JSON.stringify(["spills/17.bash.log"]) &&
					(await filesExist([
						path.join(entryDir, `${id}.jsonl`),
						path.join(entryDir, `${id}.jsonl.tombstone`),
						path.join(entryDir, "spills", "17.bash.log"),
					]));
			} catch {}
			try {
				if (
					(await readdir(path.join(parentArtifactsDir, ".fanout-archive", ".txn"))).some(name =>
						name.startsWith(`${id}.`),
					)
				) {
					return false;
				}
			} catch {}
			return (active ? 1 : 0) + (published ? 1 : 0) === 1;
		},
	};
}

describe("fanout archive", () => {
	it("normalizes fanout archive settings and keeps one manager per current parent directory", () => {
		using temp = TempDir.createSync("@omp-fanout-archive-");
		const settings = Settings.isolated({
			"task.fanoutArchive.archiveLimitBytes": Number.NaN,
			"task.fanoutArchive.reserveBytesPerChild": -1,
		});
		const manager = SessionManager.create(temp.path(), temp.path());

		expect(fanoutArchiveSettings(settings)).toEqual({
			enabled: true,
			archiveLimitBytes: 1_073_741_824,
			minimumFreeBytes: 1_073_741_824,
			reserveBytesPerChild: 67_108_864,
			strictActiveTerminalLimitBytes: 0,
		});
		expect(manager.getFanoutArchiveManager()).toBe(manager.getFanoutArchiveManager());
	});

	it("shares the parent manager when its artifact manager is adopted", () => {
		using temp = TempDir.createSync("@omp-fanout-archive-adopted-");
		const parent = SessionManager.create(temp.path(), temp.path());
		const parentArtifactManager = parent.getArtifactManager();
		if (!parentArtifactManager) throw new Error("Expected a persistent parent artifact manager");

		const child = SessionManager.create(temp.path(), temp.path());
		child.adoptArtifactManager(parentArtifactManager);

		expect(child.getFanoutArchiveManager()).toBe(parent.getFanoutArchiveManager());
	});
	it("selects only stable tombstoned aborted children oldest first and counts only owned completed spills", async () => {
		using temp = TempDir.createSync("@omp-fanout-archive-terminal-");
		const fixture = await parentFixture(temp.path());
		await fixture.writeChild("Old", {
			terminalAt: 10,
			spills: ["17.bash.log"],
		});
		await fixture.writeChild("SharedFirst", {
			terminalAt: 1,
			spills: ["29.bash.log"],
		});
		await fixture.writeChild("SharedSecond", {
			terminalAt: 2,
			spills: ["29.bash.log"],
		});
		await fixture.writeChild("ParentReference", {
			terminalAt: 3,
			transcript: `${JSON.stringify({ type: "session_init", task: "Inspect artifact://30" })}\n`,
		});
		await writeFile(path.join(fixture.parentArtifactsDir, "30.bash.log"), "parent-owned");
		await fixture.writeChild("New", {
			terminalAt: 20,
			spills: ["18.read.log"],
		});
		await fixture.writeChild("Capacity", {
			terminalAt: 30,
			spills: ["20.bash.log"],
		});
		await fixture.writeChild("Idle", {
			status: "idle",
			terminalAt: 40,
			spills: ["21.bash.log"],
		});
		await fixture.writeChild("Parked", {
			status: "parked",
			terminalAt: 50,
			spills: ["22.bash.log"],
		});
		await fixture.writeChild("Vibe", {
			terminalAt: 60,
			spills: ["23.bash.log"],
		});
		fixture.revivable.add("Vibe");
		await fixture.writeChild("Malformed", { terminalAt: 70, transcript: "{" });
		await fixture.writeChild("Changing", {
			terminalAt: 80,
			spills: ["24.bash.log"],
		});
		fixture.changing.add(path.join(fixture.parentArtifactsDir, "Changing.jsonl"));
		await fixture.writeChild("Linked", {
			terminalAt: 90,
			spills: ["25.bash.log"],
		});
		await link(
			path.join(fixture.parentArtifactsDir, "Linked.jsonl"),
			path.join(fixture.parentArtifactsDir, "linked-transcript-copy.jsonl"),
		);
		await fixture.writeChild("Symlinked", { terminalAt: 100 });
		const symlinkTarget = path.join(temp.path(), "symlink-target.jsonl");
		await writeFile(symlinkTarget, "{}\n");
		await rm(path.join(fixture.parentArtifactsDir, "Symlinked.jsonl"));
		await symlink(symlinkTarget, path.join(fixture.parentArtifactsDir, "Symlinked.jsonl"));
		await fixture.writeChild("Escaped", {
			terminalAt: 110,
			sessionFile: path.join(temp.path(), "escaped.jsonl"),
		});
		await fixture.writeChild("Ambiguous", {
			terminalAt: 120,
			spills: ["26.one.log", "26.two.log"],
		});
		await fixture.writeChild("Duplicate", {
			terminalAt: 130,
			spills: ["27.bash.log"],
		});
		await fixture.writeChild("Taken", {
			terminalAt: 140,
			spills: ["28.bash.log"],
		});
		await mkdir(path.join(fixture.archiveEntriesDir, "Duplicate"), {
			recursive: true,
		});
		await writeFile(path.join(fixture.archiveEntriesDir, "Duplicate", "manifest.json"), "{}");
		await mkdir(path.join(fixture.archiveEntriesDir, "Taken"), {
			recursive: true,
		});
		await writeFile(path.join(fixture.parentArtifactsDir, "19.bash.log"), "unknown");

		const manager = fixture.manager((await fixture.bytesOf("Old")) + (await fixture.bytesOf("New")) + 1);
		await manager.archiveTerminalChildren();

		expect(await fixture.publishedIds()).toEqual(["Old", "New"]);
		expect(await fixture.activeFiles()).toEqual(
			expect.arrayContaining([
				"19.bash.log",
				"Capacity.jsonl",
				"Idle.jsonl",
				"Parked.jsonl",
				"Vibe.jsonl",
				"Malformed.jsonl",
				"Changing.jsonl",
				"Linked.jsonl",
				"Symlinked.jsonl",
				"Escaped.jsonl",
				"Ambiguous.jsonl",
				"Duplicate.jsonl",
				"SharedFirst.jsonl",
				"SharedSecond.jsonl",
				"ParentReference.jsonl",
				"30.bash.log",
				"Taken.jsonl",
			]),
		);
		expect(manager.snapshot()).toMatchObject({
			archiveUsedBytes: await fixture.bytesOfPublishedEntries(),
			activeTerminalBytes: await fixture.bytesOf("Capacity"),
			archiveReclaimableBytes: 0,
		});
	});
	it("keeps active or revivable children authoritative during archive races at and above max concurrency", async () => {
		using temp = TempDir.createSync("@omp-fanout-archive-high-fanout-");
		const fixture = await parentFixture(temp.path());
		await fixture.writeChild("Revived", {
			terminalAt: 0,
			spills: ["1000.bash.log"],
		});
		await Promise.all(
			Array.from({ length: 65 }, (_, index) =>
				fixture.writeChild(`Child${index + 1}`, {
					terminalAt: index + 1,
					spills: [`${index + 1}.bash.log`],
				}),
			),
		);
		fixture.files.barrier("before-first-rename", () => {
			fixture.revivable.add("Revived");
			fixture.liveness.set("Revived", {
				status: "idle",
				sessionFile: path.join(fixture.parentArtifactsDir, "Revived.jsonl"),
			});
		});

		const manager = fixture.manager(Number.MAX_SAFE_INTEGER);
		const original = await readFile(path.join(fixture.parentArtifactsDir, "Revived.jsonl"), "utf8");
		const readers = Array.from({ length: 24 }, () => manager.resolveArchivedTranscript("Revived"));
		await Promise.all([manager.archiveTerminalChildren(), manager.archiveTerminalChildren(), ...readers]);

		const publishedIds = await fixture.publishedIds();
		expect(await readFile(path.join(fixture.parentArtifactsDir, "Revived.jsonl"), "utf8")).toBe(original);
		expect(publishedIds).not.toContain("Revived");
		expect(new Set(publishedIds).size).toBe(publishedIds.length);
		expect(fixture.files.copyCalls).toBe(0);
		expect(fixture.files.unlinkCallsForData).toBe(0);
	});
	it.each([
		["transcript", "Writer.jsonl"],
		["spill", "17.bash.log"],
	] as const)("keeps the active %s writer authoritative when it races archival", async (_kind, file) => {
		using temp = TempDir.createSync("@omp-fanout-archive-writer-race-");
		const fixture = await parentFixture(temp.path());
		await fixture.writeChild("Writer", {
			terminalAt: 1,
			spills: ["17.bash.log"],
		});
		const source = path.join(fixture.parentArtifactsDir, file);
		const original = await readFile(source, "utf8");
		fixture.files.barrier("before-first-rename", async () => {
			await appendFile(source, "writer");
		});

		await fixture.manager(Number.MAX_SAFE_INTEGER).archiveTerminalChildren();

		expect(await readFile(source, "utf8")).toBe(`${original}writer`);
		expect(await fixture.publishedIds()).not.toContain("Writer");
		expect(await fixture.hasOnlyCompleteActiveOrPublishedEntry("Writer")).toBe(true);
	});
	it("admits 24 production children without injected dependencies and releases their reservations", async () => {
		using temp = TempDir.createSync("@omp-fanout-archive-production-preflight-");
		const manager = FanoutArchiveManager.forParent(temp.path(), undefined, {
			fresh: true,
		});
		const reservation = await manager.preflight({
			childCount: 24,
			settings: {
				enabled: true,
				archiveLimitBytes: 1_073_741_824,
				minimumFreeBytes: 0,
				reserveBytesPerChild: 1,
				strictActiveTerminalLimitBytes: 0,
			},
		});

		await Promise.all(Array.from({ length: 24 }, () => reservation.claimChild()));
		for (let index = 0; index < 24; index += 1) reservation.settleChild();
		expect(manager.snapshot().reservedBytes).toBe(0);
	});
	it("archives an ordinary production child through the memoized parent manager", async () => {
		using temp = TempDir.createSync("@omp-fanout-archive-production-archive-");
		const parent = temp.join("parent");
		await mkdir(parent);
		const sessionFile = path.join(parent, "Dead.jsonl");
		await writeFile(
			sessionFile,
			`${JSON.stringify({ type: "message", message: { role: "user", content: "done" } })}\n`,
		);
		await writeFile(`${sessionFile}.tombstone`, "");
		AgentRegistry.resetGlobalForTests();
		AgentRegistry.global().register({
			id: "Dead",
			displayName: "Dead",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile,
			status: "aborted",
		});

		await FanoutArchiveManager.forParent(parent, undefined, {
			fresh: true,
		}).archiveTerminalChildren();

		expect(await readFile(path.join(parent, ".fanout-archive", "entries", "Dead", "Dead.jsonl"), "utf8")).toContain(
			"done",
		);
		AgentRegistry.resetGlobalForTests();
	});
	it("rejects 24-child preflight when strict active-terminal or archive budgets are exhausted", async () => {
		using temp = TempDir.createSync("@omp-fanout-archive-budget-preflight-");
		const fixture = await parentFixture(temp.path());
		await fixture.writeChild("Dead", {
			terminalAt: 1,
			spills: ["17.bash.log"],
		});
		const strictManager = fixture.manager(0);
		await strictManager.archiveTerminalChildren();
		const settings = {
			enabled: true,
			archiveLimitBytes: 0,
			minimumFreeBytes: 0,
			reserveBytesPerChild: 0,
			strictActiveTerminalLimitBytes: 1,
		};

		await expect(strictManager.preflight({ childCount: 24, settings })).rejects.toMatchObject({
			kind: "active-terminal-limit",
		});

		await fixture.restartManager(Number.MAX_SAFE_INTEGER).archiveTerminalChildren();
		await expect(fixture.restartManager(0).preflight({ childCount: 24, settings })).rejects.toMatchObject({
			kind: "archive-capacity",
		});
	});
	it.each(["before-first-rename", "after-transcript-rename", "after-spill-rename", "before-manifest"])(
		"recovers %s without copy/delete fallback",
		async failurePoint => {
			using temp = TempDir.createSync("@omp-fanout-archive-recovery-");
			const fixture = await parentFixture(temp.path());
			await fixture.writeChild("Dead", {
				terminalAt: 1,
				spills: ["17.bash.log"],
			});
			fixture.files.failAt(failurePoint);

			const initial = fixture.manager(Number.MAX_SAFE_INTEGER);
			await expect(initial.archiveTerminalChildren()).rejects.toThrow(`Injected interruption at ${failurePoint}`);
			fixture.files.failAt(undefined);
			const restarted = fixture.restartManager(Number.MAX_SAFE_INTEGER);
			expect(restarted).not.toBe(initial);
			await restarted.recover();

			expect(await fixture.hasOnlyCompleteActiveOrPublishedEntry("Dead")).toBe(true);
			expect(fixture.files.copyCalls).toBe(0);
			expect(fixture.files.unlinkCallsForData).toBe(0);
		},
	);
	it.each(["archiveTerminalChildren", "resolveArchivedTranscript"] as const)(
		"recovers an interrupted transaction on first %s without an explicit recover()",
		async entryPoint => {
			using temp = TempDir.createSync("@omp-fanout-archive-implicit-recovery-");
			const fixture = await parentFixture(temp.path());
			await fixture.writeChild("Dead", { terminalAt: 1, spills: ["17.bash.log"] });
			fixture.files.failAt("after-transcript-rename");

			const initial = fixture.manager(Number.MAX_SAFE_INTEGER);
			await expect(initial.archiveTerminalChildren()).rejects.toThrow();
			fixture.files.failAt(undefined);

			// Nothing in production calls recover(); a restarted process reaches the
			// archive only through these entry points, so they must finalize the
			// interrupted transaction themselves or the transcript stays in .staging.
			const restarted = fixture.restartManager(Number.MAX_SAFE_INTEGER);
			if (entryPoint === "archiveTerminalChildren") await restarted.archiveTerminalChildren();
			else await restarted.resolveArchivedTranscript("Dead");

			expect(await fixture.hasOnlyCompleteActiveOrPublishedEntry("Dead")).toBe(true);
			expect(fixture.files.copyCalls).toBe(0);
			expect(fixture.files.unlinkCallsForData).toBe(0);
		},
	);
	it("preserves the journal and reports an unrecoverable missing staged file", async () => {
		using temp = TempDir.createSync("@omp-fanout-archive-missing-staged-");
		const fixture = await parentFixture(temp.path());
		await fixture.writeChild("Dead", {
			terminalAt: 1,
			spills: ["17.bash.log"],
		});
		fixture.files.failAt("after-transcript-rename");
		await expect(fixture.manager(Number.MAX_SAFE_INTEGER).archiveTerminalChildren()).rejects.toThrow();
		fixture.files.failAt(undefined);
		const [stage] = await readdir(path.join(fixture.parentArtifactsDir, ".fanout-archive", ".staging"));
		await rm(path.join(fixture.parentArtifactsDir, ".fanout-archive", ".staging", stage, "Dead.jsonl"));

		const restarted = fixture.restartManager(Number.MAX_SAFE_INTEGER);
		await restarted.recover();

		expect(restarted.snapshot().unhealthyTransaction?.reason).toBe("missing file");
		await expect(readFile(path.join(fixture.parentArtifactsDir, "Dead.jsonl"), "utf8")).rejects.toThrow();
		expect(await fixture.publishedIds()).toEqual([]);
	});
	it("durably publishes a journal before renaming source data", async () => {
		using temp = TempDir.createSync("@omp-fanout-archive-journal-");
		const fixture = await parentFixture(temp.path());
		await fixture.writeChild("Dead", {
			terminalAt: 1,
			spills: ["17.bash.log"],
		});

		await fixture.manager(Number.MAX_SAFE_INTEGER).archiveTerminalChildren();

		expect(fixture.files.operations.some(operation => /^sync:\.Dead\..+\.json\..+\.tmp$/.test(operation))).toBe(true);
		expect(fixture.files.operations).toContain("sync:.txn");
	});

	it("preserves a journal and surfaces an unhealthy transaction when publication is altered", async () => {
		using temp = TempDir.createSync("@omp-fanout-archive-published-check-");
		const fixture = await parentFixture(temp.path());
		await fixture.writeChild("Dead", {
			terminalAt: 1,
			spills: ["17.bash.log"],
		});
		fixture.files.barrier("after-entry-rename-before-verification", async () => {
			await rm(path.join(fixture.archiveEntriesDir, "Dead", "spills", "17.bash.log"));
		});

		await expect(fixture.manager(Number.MAX_SAFE_INTEGER).archiveTerminalChildren()).rejects.toThrow(
			"Published archive entry does not match transaction",
		);
		expect(fixture.manager(Number.MAX_SAFE_INTEGER).snapshot().unhealthyTransaction?.id).toBe("Dead");
	});

	it("preserves a recreated active source during rollback and clears unhealthy state after resolution", async () => {
		using temp = TempDir.createSync("@omp-fanout-archive-rollback-collision-");
		const fixture = await parentFixture(temp.path());
		await fixture.writeChild("Dead", {
			terminalAt: 1,
			spills: ["17.bash.log"],
		});
		fixture.files.failAt("after-transcript-rename");
		await expect(fixture.manager(Number.MAX_SAFE_INTEGER).archiveTerminalChildren()).rejects.toThrow();
		fixture.files.failAt(undefined);
		fixture.files.barrier("before-rollback-rename", async () => {
			await writeFile(path.join(fixture.parentArtifactsDir, "Dead.jsonl"), "recreated");
		});

		const restarted = fixture.restartManager(Number.MAX_SAFE_INTEGER);
		await restarted.recover();
		expect(await readFile(path.join(fixture.parentArtifactsDir, "Dead.jsonl"), "utf8")).toBe("recreated");
		expect(restarted.snapshot().unhealthyTransaction?.id).toBe("Dead");

		fixture.files.barrier("before-rollback-rename", () => {});
		await rm(path.join(fixture.parentArtifactsDir, "Dead.jsonl"));
		await restarted.recover();
		expect(restarted.snapshot().unhealthyTransaction).toBeUndefined();
	});

	it("recovers a complete staged transaction with an orphaned manifest temporary", async () => {
		using temp = TempDir.createSync("@omp-fanout-archive-orphan-temp-");
		const fixture = await parentFixture(temp.path());
		await fixture.writeChild("Dead", {
			terminalAt: 1,
			spills: ["17.bash.log"],
		});
		fixture.files.failAt("before-manifest");
		await expect(fixture.manager(Number.MAX_SAFE_INTEGER).archiveTerminalChildren()).rejects.toThrow();
		fixture.files.failAt(undefined);
		const [stage] = await readdir(path.join(fixture.parentArtifactsDir, ".fanout-archive", ".staging"));
		await writeFile(
			path.join(fixture.parentArtifactsDir, ".fanout-archive", ".staging", stage, "manifest.json.tmp"),
			"orphan",
		);

		await fixture.restartManager(Number.MAX_SAFE_INTEGER).recover();
		expect(await fixture.hasOnlyCompleteActiveOrPublishedEntry("Dead")).toBe(true);
	});

	it("refuses to publish a staged file that no longer matches its journal", async () => {
		using temp = TempDir.createSync("@omp-fanout-archive-staged-mismatch-");
		const fixture = await parentFixture(temp.path());
		await fixture.writeChild("Dead", {
			terminalAt: 1,
			spills: ["17.bash.log"],
		});
		fixture.files.barrier("before-manifest", async () => {
			const [stage] = await readdir(path.join(fixture.parentArtifactsDir, ".fanout-archive", ".staging"));
			await appendFile(
				path.join(fixture.parentArtifactsDir, ".fanout-archive", ".staging", stage, "Dead.jsonl"),
				"changed",
			);
		});

		await expect(fixture.manager(Number.MAX_SAFE_INTEGER).archiveTerminalChildren()).rejects.toThrow();
		await expect(lstat(path.join(fixture.archiveEntriesDir, "Dead"))).rejects.toThrow();
	});

	it("syncs created and moved directories before deleting a transaction journal", async () => {
		using temp = TempDir.createSync("@omp-fanout-archive-directory-sync-");
		const fixture = await parentFixture(temp.path());
		await fixture.writeChild("Dead", {
			terminalAt: 1,
			spills: ["17.bash.log"],
		});
		fixture.files.failAt("after-transcript-rename");
		await expect(fixture.manager(Number.MAX_SAFE_INTEGER).archiveTerminalChildren()).rejects.toThrow();
		fixture.files.failAt(undefined);
		await fixture.restartManager(Number.MAX_SAFE_INTEGER).recover();

		expect(fixture.files.operations).toEqual(
			expect.arrayContaining(["sync:parent", "sync:.fanout-archive", "sync:.staging"]),
		);
	});
});
