import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/artifact-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import {
	hasResolvableTranscript,
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
	sessionFilesFromDisk,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { type FanoutArchiveDependencies, FanoutArchiveManager } from "@oh-my-pi/pi-coding-agent/session/fanout-archive";

function transcript(): string {
	const timestamp = new Date().toISOString();
	return [
		JSON.stringify({
			type: "session",
			version: 3,
			id: "Dead",
			timestamp,
			cwd: "/tmp",
		}),
		JSON.stringify({
			type: "message",
			id: "message-1",
			parentId: null,
			timestamp,
			message: { role: "user", content: "child transcript", timestamp: 1 },
		}),
		"",
	].join("\n");
}

function archiveDependencies(): FanoutArchiveDependencies {
	return {
		fs: {
			stat: fs.stat,
			lstat: fs.lstat,
			statfs: fs.statfs,
			readdir: async directory => fs.readdir(directory),
			readFile: fs.readFile,
			writeFile: fs.writeFile,
			mkdir: async (directory, options) => {
				await fs.mkdir(directory, options);
			},
			rename: fs.rename,
			renameNoReplace: fs.rename,
			sync: async () => {},
			removeJournal: async file => fs.rm(file),
		},
		now: Date.now,
		childLiveness: () => undefined,
		isVibeRevivable: () => false,
	};
}

describe("fanout archive reader compatibility", () => {
	let root: string;
	let parent: string;
	let unregister: (() => void) | undefined;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "fanout-archive-reader-"));
		parent = path.join(root, "parent");
		await fs.mkdir(path.join(parent, ".fanout-archive", "entries", "Dead", "spills"), { recursive: true });
		await Bun.write(path.join(parent, "Dead.md"), "compact");
		await Bun.write(path.join(parent, ".fanout-archive", "entries", "Dead", "Dead.jsonl"), transcript());
		await Bun.write(path.join(parent, ".fanout-archive", "entries", "Dead", "Dead.jsonl.tombstone"), "");
		await Bun.write(path.join(parent, ".fanout-archive", "entries", "Dead", "spills", "17.bash.log"), "raw spill");
		await Bun.write(
			path.join(parent, ".fanout-archive", "entries", "Dead", "manifest.json"),
			JSON.stringify({
				version: 1,
				id: "Dead",
				terminalAt: 1,
				transcript: "Dead.jsonl",
				tombstone: "Dead.jsonl.tombstone",
				spills: ["spills/17.bash.log"],
				bytes: 1,
				archivedAt: 1,
			}),
		);
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
		InternalUrlRouter.resetForTests();
		FanoutArchiveManager.forParent(parent, archiveDependencies());
		unregister = registerArtifactsDir(parent);
	});

	afterEach(async () => {
		unregister?.();
		resetRegisteredArtifactDirsForTests();
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
		await fs.rm(root, { recursive: true, force: true });
	});
	it("keeps the active transcript authoritative for concurrent history readers", async () => {
		const activeSessionFile = path.join(parent, "Dead.jsonl");
		await Bun.write(activeSessionFile, transcript().replace("child transcript", "active transcript"));
		AgentRegistry.global().register({
			id: "Dead",
			displayName: "Dead",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: activeSessionFile,
			status: "idle",
		});

		const histories = await Promise.all(
			Array.from({ length: 24 }, () => InternalUrlRouter.instance().resolve("history://Dead")),
		);

		expect(histories).toHaveLength(24);
		for (const history of histories) {
			expect(history.content).toContain("active transcript");
			expect(history.sourcePath).toBe(activeSessionFile);
		}
	});
	it("does not reuse an artifact ID when publication lands between active and archive snapshots", async () => {
		let resolveActiveFiles!: (files: string[]) => void;
		const activeFiles = new Promise<string[]>(resolve => {
			resolveActiveFiles = resolve;
		});
		let resolveArchivedIds!: (ids: readonly string[]) => void;
		const archivedIds = new Promise<readonly string[]>(resolve => {
			resolveArchivedIds = resolve;
		});
		let signalActiveRead!: () => void;
		const activeReadStarted = new Promise<void>(resolve => {
			signalActiveRead = resolve;
		});
		let archiveReadStarted = false;
		const manager = new ArtifactManager(parent, {
			readdir: async () => {
				signalActiveRead();
				return activeFiles;
			},
			mkdir: async () => {},
			archiveManager: {
				archivedArtifactIds: async () => {
					archiveReadStarted = true;
					return archivedIds;
				},
				resolveArchivedArtifact: async () => undefined,
			},
		});

		const allocation = manager.allocatePath("bash");
		await activeReadStarted;
		if (archiveReadStarted) {
			resolveArchivedIds([]);
			resolveActiveFiles([]);
		} else {
			resolveActiveFiles(["18.bash.log"]);
			while (!archiveReadStarted) await Promise.resolve();
			resolveArchivedIds([]);
		}

		expect((await allocation).id).toBe("19");
	});

	it("keeps compact history and artifact identities stable after terminal archival and relocation", async () => {
		const history = await InternalUrlRouter.instance().resolve("history://Dead");
		const artifact = await new ArtifactProtocolHandler().resolve(parseInternalUrl("artifact://17"), {
			pathOnly: true,
		});
		const managedArtifactPath = await new ArtifactManager(parent).getPath("17");
		const completions = await new ArtifactProtocolHandler().complete();

		expect(history.content).toContain("child transcript");
		expect(artifact.sourcePath).toContain("entries/Dead/spills/17.bash.log");
		expect(managedArtifactPath).toContain("entries/Dead/spills/17.bash.log");
		expect(completions).toContainEqual({ value: "17" });
		expect(await Bun.file(path.join(parent, "Dead.md")).text()).toBe("compact");
		expect((await sessionFilesFromDisk()).has("Dead")).toBe(false);
	});
	it("reserves archived artifact IDs when a resumed parent allocates output", async () => {
		const allocation = await new ArtifactManager(parent).allocatePath("bash");

		expect(allocation.id).toBe("18");
	});

	it("prefers the pinned parent's archived artifact over another session's active artifact", async () => {
		const other = path.join(root, "other");

		await fs.mkdir(other);
		await Bun.write(path.join(other, "17.bash.log"), "other session");
		const unregisterOther = registerArtifactsDir(other);
		try {
			const artifact = await new ArtifactProtocolHandler().resolve(parseInternalUrl("artifact://17"), {
				pathOnly: true,
				localProtocolOptions: { getArtifactsDir: () => parent },
			});

			expect(artifact.sourcePath).toContain("entries/Dead/spills/17.bash.log");
		} finally {
			unregisterOther();
		}
	});

	it("keeps archived transcripts case-insensitive and available without reviving them", async () => {
		const history = await InternalUrlRouter.instance().resolve("history://dead");

		expect(history.content).toContain("child transcript");
		expect(await hasResolvableTranscript("Dead")).toBe(true);
		await registerPersistedSubagents(AgentRegistry.global(), `${parent}.jsonl`);
		expect(AgentRegistry.global().get("Dead")).toBeUndefined();
	});

	it("falls back to the published transcript when a parked ref still names its relocated active path", async () => {
		AgentRegistry.global().register({
			id: "Dead",
			displayName: "Dead",
			kind: "sub",
			session: null,
			sessionFile: path.join(parent, "Dead.jsonl"),
			status: "aborted",
		});

		const history = await InternalUrlRouter.instance().resolve("history://Dead");

		expect(history.content).toContain("child transcript");
		expect(history.sourcePath).toContain("entries/Dead/Dead.jsonl");
	});

	it("reports a corrupt published entry rather than silently treating it as absent", async () => {
		await fs.rm(path.join(parent, ".fanout-archive", "entries", "Dead", "manifest.json"));
		await expect(new ArtifactManager(parent).allocatePath("bash")).rejects.toThrow(/archive entry Dead is corrupt/i);
		await expect(InternalUrlRouter.instance().resolve("history://Dead")).rejects.toThrow(
			/archive entry Dead is corrupt/i,
		);
		await expect(new ArtifactProtocolHandler().resolve(parseInternalUrl("artifact://17"))).rejects.toThrow(
			/archive entry Dead is corrupt/i,
		);
	});
});
