import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { Settings } from "../config/settings";
import { AgentRegistry } from "../registry/agent-registry";

export interface FanoutArchiveSettings {
	enabled: boolean;
	archiveLimitBytes: number;
	minimumFreeBytes: number;
	reserveBytesPerChild: number;
	strictActiveTerminalLimitBytes: number;
}

export interface FanoutArchiveFileStat {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	nlink: number;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

export interface FanoutArchiveFileSystem {
	stat(path: string): Promise<FanoutArchiveFileStat>;
	lstat(path: string): Promise<FanoutArchiveFileStat>;
	statfs(path: string): Promise<{ bavail: number; bsize: number }>;
	readdir(path: string): Promise<readonly string[]>;
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, data: string | Uint8Array, options?: { flag?: "wx" }): Promise<void>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	renameNoReplace(from: string, to: string): Promise<void>;
	sync(path: string): Promise<void>;
	removeJournal(path: string): Promise<void>;
}

export interface FanoutArchiveDependencies {
	fs: FanoutArchiveFileSystem;
	now(): number;
	childLiveness(id: string):
		| {
				status: "running" | "idle" | "parked" | "aborted";
				sessionFile?: string;
		  }
		| undefined;
	isVibeRevivable(id: string): boolean;
	barrier?(point: string): Promise<void>;
	archiveSettings?: FanoutArchiveSettings;
}

export interface FanoutArchiveSnapshot {
	filesystemFreeBytes: number;
	minimumFreeBytes: number;
	reservedBytes: number;
	archiveUsedBytes: number;
	archiveLimitBytes: number;
	activeTerminalBytes: number;
	archiveReclaimableBytes: number;
	healthyTransactionIds: readonly string[];
	unhealthyTransaction?: {
		id: string;
		paths: readonly string[];
		reason: string;
	};
}

export interface FanoutPreflightRequest {
	childCount: number;
	settings: FanoutArchiveSettings;
	estimatedBytesPerChild?: number;
}

export interface FanoutArchiveReservation {
	readonly parentArtifactsDir: string;
	claimChild(): Promise<void>;
	releaseUnclaimedChild(): void;
	settleChild(): void;
	cancel(): void;
}

export type FanoutStoragePreflightErrorKind =
	| "physical-space"
	| "archive-capacity"
	| "active-terminal-limit"
	| "unsafe-recovery"
	| "cross-device";

export class FanoutStoragePreflightError extends Error {
	readonly kind: FanoutStoragePreflightErrorKind;

	constructor(kind: FanoutStoragePreflightErrorKind, message: string) {
		super(message);
		this.name = "FanoutStoragePreflightError";
		this.kind = kind;
	}
}

function finiteNonNegative(value: number, fallback: number): number {
	return Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function fanoutArchiveSettings(settings: Settings): FanoutArchiveSettings {
	return {
		enabled: settings.get("task.fanoutArchive.enabled"),
		archiveLimitBytes: finiteNonNegative(settings.get("task.fanoutArchive.archiveLimitBytes"), 1_073_741_824),
		minimumFreeBytes: finiteNonNegative(settings.get("task.fanoutArchive.minimumFreeBytes"), 1_073_741_824),
		reserveBytesPerChild: finiteNonNegative(settings.get("task.fanoutArchive.reserveBytesPerChild"), 67_108_864),
		strictActiveTerminalLimitBytes: finiteNonNegative(
			settings.get("task.fanoutArchive.strictActiveTerminalLimitBytes"),
			0,
		),
	};
}
interface ArchiveSource {
	path: string;
	stat: FanoutArchiveFileStat;
}

interface TerminalArchiveCandidate {
	id: string;
	terminalAt: number;
	transcriptMtimeMs: number;
	bytes: number;
	sources: readonly ArchiveSource[];
}

interface ArchiveFileIdentity {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
}

interface ArchiveJournalFile {
	source: string;
	staged: string;
	destination: string;
	identity: ArchiveFileIdentity;
}

interface ArchiveManifest {
	version: 1;
	id: string;
	terminalAt: number;
	transcript: string;
	tombstone: string;
	spills: readonly string[];
	bytes: number;
	archivedAt: number;
}

interface ArchiveJournal {
	version: 1;
	id: string;
	nonce: string;
	device: number;
	stageDir: string;
	entryDir: string;
	files: readonly ArchiveJournalFile[];
	manifest: ArchiveManifest;
}

export class FanoutArchiveMoveError extends Error {
	readonly kind: "cross-device";

	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "FanoutArchiveMoveError";
		this.kind = "cross-device";
	}
}

export class FanoutArchiveCorruptionError extends Error {
	constructor(entryId: string, reason: string) {
		super(`Fanout archive entry ${entryId} is corrupt: ${reason}`);
		this.name = "FanoutArchiveCorruptionError";
	}
}

function archiveFileIdentity(stat: FanoutArchiveFileStat): ArchiveFileIdentity {
	return {
		dev: stat.dev,
		ino: stat.ino,
		size: stat.size,
		mtimeMs: stat.mtimeMs,
	};
}

function matchesArchiveFileIdentity(stat: FanoutArchiveFileStat, identity: ArchiveFileIdentity): boolean {
	return (
		stat.dev === identity.dev &&
		stat.ino === identity.ino &&
		stat.size === identity.size &&
		stat.mtimeMs === identity.mtimeMs
	);
}
function sameFileIdentity(left: FanoutArchiveFileStat, right: FanoutArchiveFileStat): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

function isSafeRegularFile(stat: FanoutArchiveFileStat): boolean {
	return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function productionDependencies(): FanoutArchiveDependencies {
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
			renameNoReplace: async (from, to) => {
				try {
					await fs.lstat(to);
					throw Object.assign(new Error(`Archive destination already exists: ${to}`), { code: "EEXIST" });
				} catch (error) {
					if (!isMissingFile(error)) throw error;
				}
				await fs.rename(from, to);
			},
			sync: async file => {
				const handle = await fs.open(file, "r");
				try {
					await handle.sync();
				} finally {
					await handle.close();
				}
			},
			removeJournal: async file => fs.rm(file),
		},
		now: Date.now,
		childLiveness: id => {
			const agent = AgentRegistry.global().get(id);
			if (!agent) return undefined;
			return {
				status: agent.status,
				...(agent.sessionFile === null ? {} : { sessionFile: agent.sessionFile }),
			};
		},
		isVibeRevivable: () => false,
	};
}

export class FanoutArchiveManager {
	static readonly #managersByParentArtifactsDir = new Map<string, FanoutArchiveManager>();

	readonly parentArtifactsDir: string;
	readonly #dependencies: FanoutArchiveDependencies;
	readonly #settings: FanoutArchiveSettings;
	#snapshot: FanoutArchiveSnapshot;
	#mutex = Promise.resolve();
	#transactionSequence = 0;
	#archivedArtifactPaths = new Map<string, string>();
	#recovered = false;
	#recovery: Promise<void> | undefined;

	private constructor(parentArtifactsDir: string, dependencies?: FanoutArchiveDependencies) {
		this.parentArtifactsDir = parentArtifactsDir;
		this.#dependencies = dependencies ?? productionDependencies();
		this.#settings = this.#dependencies.archiveSettings ?? {
			enabled: true,
			archiveLimitBytes: 1_073_741_824,
			minimumFreeBytes: 1_073_741_824,
			reserveBytesPerChild: 67_108_864,
			strictActiveTerminalLimitBytes: 0,
		};
		this.#snapshot = {
			filesystemFreeBytes: 0,
			minimumFreeBytes: this.#settings.minimumFreeBytes,
			reservedBytes: 0,
			archiveUsedBytes: 0,
			archiveLimitBytes: this.#settings.archiveLimitBytes,
			activeTerminalBytes: 0,
			archiveReclaimableBytes: 0,
			healthyTransactionIds: [],
			unhealthyTransaction: undefined,
		};
	}

	static forParent(
		parentArtifactsDir: string,
		dependencies?: FanoutArchiveDependencies,
		options?: { fresh?: boolean },
	): FanoutArchiveManager {
		let manager = options?.fresh
			? undefined
			: FanoutArchiveManager.#managersByParentArtifactsDir.get(parentArtifactsDir);
		if (!manager) {
			manager = new FanoutArchiveManager(parentArtifactsDir, dependencies);
			if (!options?.fresh) FanoutArchiveManager.#managersByParentArtifactsDir.set(parentArtifactsDir, manager);
		}
		return manager;
	}

	async preflight(request: FanoutPreflightRequest): Promise<FanoutArchiveReservation> {
		await this.#ensureRecovered();
		return this.#withinMutex(async () => {
			const settings = request.settings;
			const childCount = request.childCount;
			if (!Number.isSafeInteger(childCount) || childCount < 1) {
				throw new Error(`Fanout storage preflight requires a positive child count, received ${childCount}`);
			}
			if (this.#snapshot.unhealthyTransaction) {
				throw new FanoutStoragePreflightError(
					"unsafe-recovery",
					`Fanout archive transaction ${this.#snapshot.unhealthyTransaction.id} requires manual recovery`,
				);
			}
			const reservationBytes = childCount * settings.reserveBytesPerChild;
			const archiveUsedBytes = await this.#publishedBytes(
				path.join(this.parentArtifactsDir, ".fanout-archive", "entries"),
			);
			const filesystem = await this.#dependencies.fs.statfs(this.parentArtifactsDir);
			const filesystemFreeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
			this.#snapshot = {
				...this.#snapshot,
				filesystemFreeBytes,
				minimumFreeBytes: settings.minimumFreeBytes,
				archiveUsedBytes,
				archiveLimitBytes: settings.archiveLimitBytes,
			};
			if (archiveUsedBytes > settings.archiveLimitBytes) {
				throw new FanoutStoragePreflightError(
					"archive-capacity",
					`Fanout storage preflight rejected ${childCount} children: archive used/limit: ${archiveUsedBytes}/${settings.archiveLimitBytes} B`,
				);
			}
			if (
				settings.strictActiveTerminalLimitBytes > 0 &&
				this.#snapshot.activeTerminalBytes > settings.strictActiveTerminalLimitBytes
			) {
				throw new FanoutStoragePreflightError(
					"active-terminal-limit",
					`Fanout storage preflight rejected ${childCount} children: strict active-terminal budget would be exceeded`,
				);
			}
			const requiredBytes = settings.minimumFreeBytes + this.#snapshot.reservedBytes + reservationBytes;
			if (filesystemFreeBytes < requiredBytes) {
				throw new FanoutStoragePreflightError(
					"physical-space",
					`Fanout storage preflight rejected ${childCount} children: physical free: ${filesystemFreeBytes} B; required reservation: ${reservationBytes} B; minimum free: ${settings.minimumFreeBytes} B; shortfall: ${requiredBytes - filesystemFreeBytes} B; archive used/limit: ${archiveUsedBytes}/${settings.archiveLimitBytes} B; reclaimable active-terminal bytes: ${this.#snapshot.archiveReclaimableBytes} B; physical free gained: 0 B`,
				);
			}
			this.#snapshot = {
				...this.#snapshot,
				reservedBytes: this.#snapshot.reservedBytes + reservationBytes,
			};
			let unclaimedChildren = childCount;
			let claimedChildren = 0;
			const release = (count: number) => {
				if (count === 0) return;
				this.#snapshot = {
					...this.#snapshot,
					reservedBytes: Math.max(0, this.#snapshot.reservedBytes - count * settings.reserveBytesPerChild),
				};
			};
			return {
				parentArtifactsDir: this.parentArtifactsDir,
				claimChild: async () => {
					await this.#withinMutex(async () => {
						if (unclaimedChildren === 0) throw new Error("Fanout archive reservation has no unclaimed children");
						const statfs = await this.#dependencies.fs.statfs(this.parentArtifactsDir);
						const freeBytes = Number(statfs.bavail) * Number(statfs.bsize);
						if (freeBytes < settings.minimumFreeBytes + this.#snapshot.reservedBytes) {
							throw new FanoutStoragePreflightError(
								"physical-space",
								`Fanout storage preflight rejected 1 children: physical free: ${freeBytes} B; physical free gained: 0 B`,
							);
						}
						unclaimedChildren -= 1;
						claimedChildren += 1;
					});
				},
				releaseUnclaimedChild: () => {
					if (unclaimedChildren === 0) return;
					unclaimedChildren -= 1;
					release(1);
				},
				settleChild: () => {
					if (claimedChildren === 0) return;
					claimedChildren -= 1;
					release(1);
				},
				cancel: () => {
					const remainingChildren = unclaimedChildren + claimedChildren;
					unclaimedChildren = 0;
					claimedChildren = 0;
					release(remainingChildren);
				},
			};
		});
	}

	async archiveTerminalChildren(): Promise<FanoutArchiveSnapshot> {
		await this.#ensureRecovered();
		return this.#withinMutex(async () => {
			const dependencies = this.#dependencies;
			if (!dependencies || !this.#settings.enabled) return this.snapshot();

			const archiveEntriesDir = path.join(this.parentArtifactsDir, ".fanout-archive", "entries");
			let archiveUsedBytes = await this.#publishedBytes(archiveEntriesDir);
			const candidates = (
				await Promise.all(
					(
						await dependencies.fs.readdir(this.parentArtifactsDir)
					)
						.filter(name => name.endsWith(".jsonl"))
						.map(name => this.#inspectTerminalChild(name.slice(0, -".jsonl".length), archiveEntriesDir)),
				)
			).filter((candidate): candidate is TerminalArchiveCandidate => candidate !== undefined);
			const spillOwners = new Map<string, number>();
			for (const candidate of candidates) {
				for (const source of candidate.sources.slice(2)) {
					spillOwners.set(source.path, (spillOwners.get(source.path) ?? 0) + 1);
				}
			}
			const orderedCandidates = candidates
				.filter(candidate => candidate.sources.slice(2).every(source => spillOwners.get(source.path) === 1))
				.sort(
					(left, right) =>
						left.terminalAt - right.terminalAt ||
						left.transcriptMtimeMs - right.transcriptMtimeMs ||
						left.id.localeCompare(right.id),
				);

			let activeTerminalBytes = 0;
			let archiveCapacityBlocked = false;
			const activeCandidates: TerminalArchiveCandidate[] = [];
			for (const candidate of orderedCandidates) {
				if (archiveCapacityBlocked || candidate.bytes > this.#settings.archiveLimitBytes - archiveUsedBytes) {
					archiveCapacityBlocked = true;
					activeCandidates.push(candidate);
					activeTerminalBytes += candidate.bytes;
					continue;
				}
				const current = await this.#inspectTerminalChild(candidate.id, archiveEntriesDir);
				if (!current || !this.#sameCandidate(candidate, current)) continue;
				if (await this.#publish(current, archiveEntriesDir)) archiveUsedBytes += current.bytes;
			}
			let remainingArchiveCapacity = Math.max(0, this.#settings.archiveLimitBytes - archiveUsedBytes);
			let archiveReclaimableBytes = 0;
			for (const candidate of activeCandidates) {
				if (candidate.bytes > remainingArchiveCapacity) break;
				archiveReclaimableBytes += candidate.bytes;
				remainingArchiveCapacity -= candidate.bytes;
			}
			this.#snapshot = {
				...this.#snapshot,
				archiveUsedBytes,
				activeTerminalBytes,
				archiveReclaimableBytes,
			};
			return this.snapshot();
		});
	}

	/**
	 * Run {@link recover} at most once per parent, before the first archive
	 * operation of the process.
	 *
	 * Recovery is gated here rather than at session startup because the archive is
	 * reached from several independent entry points (`history://`, `artifact://`,
	 * the registry helpers, Task and Vibe), each of which calls `forParent` on its
	 * own. A single startup call would leave every other path able to observe, or
	 * archive on top of, an interrupted transaction.
	 *
	 * Must be awaited *outside* `#withinMutex`: the mutex is a non-reentrant
	 * promise chain and `recover` takes it itself.
	 */
	#ensureRecovered(): Promise<void> {
		if (this.#recovered) return Promise.resolve();
		// A failed recovery is deliberately not memoized -- the next entry point
		// retries instead of permanently refusing every archive operation.
		this.#recovery ??= this.recover().finally(() => {
			this.#recovery = undefined;
		});
		return this.#recovery;
	}

	async recover(): Promise<void> {
		await this.#withinMutex(async () => {
			const dependencies = this.#dependencies;
			if (!dependencies) {
				await this.#rebuildArchivedArtifactIndex();
				return;
			}
			const transactionDir = path.join(this.parentArtifactsDir, ".fanout-archive", ".txn");
			this.#snapshot = { ...this.#snapshot, unhealthyTransaction: undefined };
			let journals: readonly string[];
			try {
				journals = await dependencies.fs.readdir(transactionDir);
			} catch (error) {
				if (isMissingFile(error)) {
					await this.#rebuildArchivedArtifactIndex();
					return;
				}
				throw error;
			}
			for (const journalName of journals.filter(name => name.endsWith(".json")).sort()) {
				await this.#recoverJournal(path.join(transactionDir, journalName));
			}
			await this.#rebuildArchivedArtifactIndex();
		});
		this.#recovered = true;
	}

	snapshot(): FanoutArchiveSnapshot {
		return {
			...this.#snapshot,
			healthyTransactionIds: [...this.#snapshot.healthyTransactionIds],
		};
	}

	async resolveArchivedTranscript(childId: string): Promise<string | undefined> {
		await this.#ensureRecovered();
		return this.#withinMutex(async () => {
			const entryId = await this.#archiveEntryId(childId);
			if (!entryId) return undefined;
			const manifest = await this.#publishedManifest(entryId);
			return manifest ? path.join(this.#entryDir(entryId), manifest.transcript) : undefined;
		});
	}

	async resolveArchivedArtifact(artifactId: string): Promise<string | undefined> {
		if (!/^\d+$/.test(artifactId)) return undefined;
		await this.#ensureRecovered();
		return this.#withinMutex(async () => {
			await this.#rebuildArchivedArtifactIndex(true);
			return this.#archivedArtifactPaths.get(artifactId);
		});
	}

	async archivedArtifactIds(): Promise<readonly string[]> {
		await this.#ensureRecovered();
		return this.#withinMutex(async () => {
			await this.#rebuildArchivedArtifactIndex(true);
			return [...this.#archivedArtifactPaths.keys()];
		});
	}

	async #archiveEntryId(id: string): Promise<string | undefined> {
		if (!id || id === "." || id === ".." || id.includes("/") || id.includes("\\")) return undefined;
		let entries: readonly string[];
		try {
			entries = await this.#readdir(path.join(this.parentArtifactsDir, ".fanout-archive", "entries"));
		} catch (error) {
			if (isMissingFile(error)) return undefined;
			throw error;
		}
		if (entries.includes(id)) return id;
		return entries.filter(entry => entry.toLowerCase() === id.toLowerCase()).sort()[0];
	}

	#entryDir(id: string): string {
		return path.join(this.parentArtifactsDir, ".fanout-archive", "entries", id);
	}

	async #rebuildArchivedArtifactIndex(strict = false): Promise<void> {
		const next = new Map<string, string>();
		let ids: readonly string[];
		try {
			ids = await this.#readdir(path.join(this.parentArtifactsDir, ".fanout-archive", "entries"));
		} catch (error) {
			if (isMissingFile(error)) {
				this.#archivedArtifactPaths = next;
				return;
			}
			throw error;
		}
		for (const id of ids) {
			try {
				const manifest = await this.#publishedManifest(id);
				if (!manifest) continue;
				for (const spill of manifest.spills) {
					const filename = path.basename(spill);
					const artifactId = filename.match(/^(\d+)\./)?.[1];
					if (artifactId && !next.has(artifactId)) next.set(artifactId, path.join(this.#entryDir(id), spill));
				}
			} catch (error) {
				if (strict || !(error instanceof FanoutArchiveCorruptionError)) throw error;
			}
		}
		this.#archivedArtifactPaths = next;
	}

	async #publishedManifest(id: string): Promise<ArchiveManifest | undefined> {
		if (!id || id === "." || id === ".." || id.includes("/") || id.includes("\\")) return undefined;
		const entryDir = this.#entryDir(id);
		try {
			await this.#readdir(entryDir);
		} catch (error) {
			if (isMissingFile(error)) return undefined;
			throw new FanoutArchiveCorruptionError(id, "entry is not a readable directory");
		}
		let manifest: ArchiveManifest;
		try {
			manifest = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(
					await this.#readFile(path.join(entryDir, "manifest.json")),
				),
			);
		} catch {
			throw new FanoutArchiveCorruptionError(id, "manifest is missing or malformed");
		}
		if (
			manifest.version !== 1 ||
			manifest.id !== id ||
			manifest.transcript !== `${id}.jsonl` ||
			manifest.tombstone !== `${id}.jsonl.tombstone` ||
			!Array.isArray(manifest.spills)
		) {
			throw new FanoutArchiveCorruptionError(id, "manifest is invalid");
		}
		const files = [manifest.transcript, manifest.tombstone, ...manifest.spills];
		for (const file of files) {
			if (
				typeof file !== "string" ||
				(file !== manifest.transcript &&
					file !== manifest.tombstone &&
					(!file.startsWith("spills/") || path.basename(file) === file)) ||
				path.resolve(entryDir, file).startsWith(`${path.resolve(entryDir)}${path.sep}`) === false
			) {
				throw new FanoutArchiveCorruptionError(id, "manifest contains an unsafe path");
			}
			try {
				const stat = await this.#lstat(path.join(entryDir, file));
				if (!isSafeRegularFile(stat))
					throw new FanoutArchiveCorruptionError(id, `published file ${file} is unsafe`);
			} catch (error) {
				if (error instanceof FanoutArchiveCorruptionError) throw error;
				throw new FanoutArchiveCorruptionError(id, `published file ${file} is missing`);
			}
		}
		return manifest;
	}

	async #readdir(directory: string): Promise<readonly string[]> {
		return this.#dependencies ? this.#dependencies.fs.readdir(directory) : fs.readdir(directory);
	}

	async #readFile(file: string): Promise<Uint8Array> {
		return this.#dependencies ? this.#dependencies.fs.readFile(file) : fs.readFile(file);
	}

	async #lstat(file: string): Promise<FanoutArchiveFileStat> {
		return this.#dependencies ? this.#dependencies.fs.lstat(file) : fs.lstat(file);
	}

	async #inspectTerminalChild(id: string, archiveEntriesDir: string): Promise<TerminalArchiveCandidate | undefined> {
		const dependencies = this.#dependencies;
		if (!dependencies || !id || id === "." || id === ".." || id.includes("/") || id.includes("\\")) return undefined;
		const transcriptPath = path.join(this.parentArtifactsDir, `${id}.jsonl`);
		const tombstonePath = `${transcriptPath}.tombstone`;
		const liveness = dependencies.childLiveness(id);
		if (
			liveness?.status !== "aborted" ||
			!liveness.sessionFile ||
			path.resolve(liveness.sessionFile) !== path.resolve(transcriptPath) ||
			dependencies.isVibeRevivable(id)
		) {
			return undefined;
		}
		try {
			await dependencies.fs.lstat(path.join(archiveEntriesDir, id));
			return undefined;
		} catch (error) {
			if (!isMissingFile(error)) return undefined;
		}

		try {
			const sources: ArchiveSource[] = [];
			for (const sourcePath of [transcriptPath, tombstonePath]) {
				const sourceStat = await dependencies.fs.lstat(sourcePath);
				if (!isSafeRegularFile(sourceStat)) return undefined;
				sources.push({ path: sourcePath, stat: sourceStat });
			}
			const transcript = new TextDecoder("utf-8", { fatal: true }).decode(
				await dependencies.fs.readFile(transcriptPath),
			);
			const artifactIds = new Set<string>();
			const unresolvedArtifactReferences = new Set<string>();
			const lines = transcript.split("\n");
			if (lines.at(-1) === "") lines.pop();
			for (const line of lines) {
				if (!line) return undefined;
				const parsed: unknown = JSON.parse(line);
				if (typeof parsed !== "object" || parsed === null) return undefined;
				const pending: unknown[] = [parsed];
				while (pending.length > 0) {
					const value = pending.pop();
					if (typeof value === "string") {
						for (const match of value.matchAll(/\bartifact:\/\/([0-9]+)\b/g))
							unresolvedArtifactReferences.add(match[1]);
					} else if (Array.isArray(value)) {
						pending.push(...value);
					} else if (typeof value === "object" && value !== null) {
						pending.push(...Object.values(value));
					}
				}
				const entry = parsed as {
					type?: unknown;
					message?: {
						role?: unknown;
						isError?: unknown;
						details?: { meta?: { truncation?: { artifactId?: unknown } } };
					};
				};
				const artifactId = entry.message?.details?.meta?.truncation?.artifactId;
				if (
					entry.type === "message" &&
					entry.message?.role === "toolResult" &&
					entry.message.isError === false &&
					typeof artifactId === "string" &&
					/^[0-9]+$/.test(artifactId)
				) {
					artifactIds.add(artifactId);
				}
			}
			if ([...unresolvedArtifactReferences].some(artifactId => !artifactIds.has(artifactId))) return undefined;
			const directEntries = await dependencies.fs.readdir(this.parentArtifactsDir);
			for (const artifactId of artifactIds) {
				const spills = directEntries.filter(name => name.startsWith(`${artifactId}.`));
				if (spills.length !== 1) return undefined;
				const spillPath = path.join(this.parentArtifactsDir, spills[0]);
				const spillStat = await dependencies.fs.lstat(spillPath);
				if (!isSafeRegularFile(spillStat)) return undefined;
				sources.push({ path: spillPath, stat: spillStat });
			}
			await dependencies.barrier?.("terminal-child-inspection-after-read");
			for (const source of sources) {
				if (!sameFileIdentity(source.stat, await dependencies.fs.lstat(source.path))) return undefined;
			}
			const checkedEntries = await dependencies.fs.readdir(this.parentArtifactsDir);
			for (const artifactId of artifactIds) {
				if (checkedEntries.filter(name => name.startsWith(`${artifactId}.`)).length !== 1) return undefined;
			}
			return {
				id,
				terminalAt: sources[1].stat.mtimeMs,
				transcriptMtimeMs: sources[0].stat.mtimeMs,
				bytes: sources.reduce((total, source) => total + source.stat.size, 0),
				sources,
			};
		} catch {
			return undefined;
		}
	}

	async #publishedBytes(archiveEntriesDir: string): Promise<number> {
		const dependencies = this.#dependencies;
		if (!dependencies) return 0;
		try {
			const entryIds = await dependencies.fs.readdir(archiveEntriesDir);
			let bytes = 0;
			for (const id of entryIds) {
				try {
					const manifest = JSON.parse(
						new TextDecoder("utf-8", { fatal: true }).decode(
							await dependencies.fs.readFile(path.join(archiveEntriesDir, id, "manifest.json")),
						),
					) as { id?: unknown; bytes?: unknown };
					if (
						manifest.id === id &&
						typeof manifest.bytes === "number" &&
						Number.isSafeInteger(manifest.bytes) &&
						manifest.bytes >= 0
					) {
						bytes += manifest.bytes;
					}
				} catch {}
			}
			return bytes;
		} catch {
			return 0;
		}
	}

	#sameCandidate(left: TerminalArchiveCandidate, right: TerminalArchiveCandidate): boolean {
		return (
			left.bytes === right.bytes &&
			left.sources.length === right.sources.length &&
			left.sources.every(
				(source, index) =>
					source.path === right.sources[index]?.path && sameFileIdentity(source.stat, right.sources[index].stat),
			)
		);
	}

	async #publish(candidate: TerminalArchiveCandidate, archiveEntriesDir: string): Promise<boolean> {
		const dependencies = this.#dependencies;
		if (!dependencies) return false;
		const current = await this.#inspectTerminalChild(candidate.id, archiveEntriesDir);
		if (!current || !this.#sameCandidate(candidate, current)) return false;

		const archiveRoot = path.dirname(archiveEntriesDir);
		const transactionDir = path.join(archiveRoot, ".txn");
		const stagingRoot = path.join(archiveRoot, ".staging");
		await Promise.all([
			dependencies.fs.mkdir(archiveEntriesDir, { recursive: true }),
			dependencies.fs.mkdir(transactionDir, { recursive: true }),
			dependencies.fs.mkdir(stagingRoot, { recursive: true }),
		]);
		await dependencies.fs.sync(this.parentArtifactsDir);
		await dependencies.fs.sync(archiveRoot);
		await dependencies.fs.sync(transactionDir);
		await dependencies.fs.sync(stagingRoot);
		await dependencies.fs.sync(archiveEntriesDir);
		const nonce = `${dependencies.now().toString(36)}-${++this.#transactionSequence}`;
		const stageDir = path.join(stagingRoot, `${current.id}.${nonce}`);
		const entryDir = path.join(archiveEntriesDir, current.id);
		try {
			await dependencies.fs.lstat(entryDir);
			return false;
		} catch (error) {
			if (!isMissingFile(error)) return false;
		}
		await dependencies.fs.mkdir(path.join(stageDir, "spills"), {
			recursive: true,
		});
		await dependencies.fs.sync(stagingRoot);
		await dependencies.fs.sync(stageDir);

		const relativeSources = current.sources.map((source, index) =>
			index < 2 ? path.basename(source.path) : path.join("spills", path.basename(source.path)),
		);
		const journal: ArchiveJournal = {
			version: 1,
			id: current.id,
			nonce,
			device: current.sources[0]?.stat.dev ?? -1,
			stageDir,
			entryDir,
			files: current.sources.map((source, index) => ({
				source: source.path,
				staged: path.join(stageDir, relativeSources[index] ?? ""),
				destination: path.join(entryDir, relativeSources[index] ?? ""),
				identity: archiveFileIdentity(source.stat),
			})),
			manifest: {
				version: 1,
				id: current.id,
				terminalAt: current.terminalAt,
				transcript: relativeSources[0] ?? "",
				tombstone: relativeSources[1] ?? "",
				spills: relativeSources.slice(2),
				bytes: current.bytes,
				archivedAt: dependencies.now(),
			},
		};
		await this.#assertSameDevice(
			[
				this.parentArtifactsDir,
				archiveRoot,
				transactionDir,
				stagingRoot,
				stageDir,
				archiveEntriesDir,
				...current.sources.map(source => source.path),
			],
			journal.device,
		);
		const journalPath = path.join(transactionDir, `${current.id}.${nonce}.json`);
		await this.#writeAtomically(journalPath, JSON.stringify(journal));
		await dependencies.barrier?.("before-first-rename");
		if (!(await this.#isStillTerminal(current))) {
			await this.#removeJournal(journalPath);
			return false;
		}
		for (const [index, file] of journal.files.entries()) {
			await this.#rename(file.source, file.staged);
			await dependencies.fs.sync(path.dirname(file.source));
			await dependencies.fs.sync(path.dirname(file.staged));
			if (index === 0) await dependencies.barrier?.("after-transcript-rename");
			if (index >= 2) await dependencies.barrier?.("after-spill-rename");
		}
		await dependencies.barrier?.("before-manifest");
		await this.#completeJournal(journal, journalPath);
		return true;
	}

	async #isStillTerminal(candidate: TerminalArchiveCandidate): Promise<boolean> {
		const dependencies = this.#dependencies;
		if (!dependencies) return false;
		const liveness = dependencies.childLiveness(candidate.id);
		if (
			liveness?.status !== "aborted" ||
			!liveness.sessionFile ||
			path.resolve(liveness.sessionFile) !==
				path.resolve(path.join(this.parentArtifactsDir, `${candidate.id}.jsonl`)) ||
			dependencies.isVibeRevivable(candidate.id)
		) {
			return false;
		}
		try {
			return (await Promise.all(candidate.sources.map(source => dependencies.fs.lstat(source.path)))).every(
				(stat, index) => sameFileIdentity(candidate.sources[index]!.stat, stat),
			);
		} catch {
			return false;
		}
	}

	async #completeJournal(journal: ArchiveJournal, journalPath: string): Promise<void> {
		const dependencies = this.#dependencies;
		if (!dependencies) return;
		const manifestPath = path.join(journal.stageDir, "manifest.json");
		try {
			const existing = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(await dependencies.fs.readFile(manifestPath)),
			);
			if (JSON.stringify(existing) !== JSON.stringify(journal.manifest)) {
				throw new Error(`Staged manifest does not match transaction ${journal.id}`);
			}
		} catch (error) {
			if (!isMissingFile(error)) throw error;
			await this.#writeAtomically(manifestPath, JSON.stringify(journal.manifest), path.dirname(journal.stageDir));
		}
		try {
			await dependencies.fs.lstat(journal.entryDir);
			throw new Error(`Archive entry collision for transaction ${journal.id}`);
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}
		const stagedStates = await Promise.all(journal.files.map(file => this.#fileState(file.staged, file.identity)));
		const activeStates = await Promise.all(journal.files.map(file => this.#fileState(file.source, file.identity)));
		if (!stagedStates.every(state => state === "match") || !activeStates.every(state => state === "missing")) {
			this.#markUnhealthy(journal.id, [journalPath, journal.stageDir], "staged files do not match transaction");
			throw new Error(`Staged archive files do not match transaction ${journal.id}`);
		}
		await this.#renameNoReplace(journal.stageDir, journal.entryDir);
		await dependencies.fs.sync(path.dirname(journal.stageDir));
		await dependencies.fs.sync(path.dirname(journal.entryDir));
		await dependencies.barrier?.("after-entry-rename-before-verification");
		if (!(await this.#publishedJournalMatches(journal))) {
			this.#markUnhealthy(journal.id, [journalPath, journal.entryDir], "published entry does not match transaction");
			throw new Error(`Published archive entry does not match transaction ${journal.id}`);
		}
		await this.#removeJournal(journalPath);
	}

	async #recoverJournal(journalPath: string): Promise<void> {
		const dependencies = this.#dependencies;
		if (!dependencies) return;
		let journal: ArchiveJournal;
		try {
			journal = this.#parseJournal(
				JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await dependencies.fs.readFile(journalPath))),
			);
		} catch {
			this.#markUnhealthy(path.basename(journalPath), [journalPath], "invalid journal");
			return;
		}
		if (!this.#journalPathsAreSafe(journal)) {
			this.#markUnhealthy(
				journal.id,
				[journalPath, journal.stageDir, journal.entryDir],
				"journal paths do not match transaction",
			);
			return;
		}
		try {
			await this.#assertSameDevice(
				[
					this.parentArtifactsDir,
					path.join(this.parentArtifactsDir, ".fanout-archive"),
					path.join(this.parentArtifactsDir, ".fanout-archive", ".txn"),
					path.join(this.parentArtifactsDir, ".fanout-archive", ".staging"),
					path.join(this.parentArtifactsDir, ".fanout-archive", "entries"),
				],
				journal.device,
			);
		} catch {
			this.#markUnhealthy(journal.id, [journalPath, journal.stageDir, journal.entryDir], "mismatched device");
			return;
		}

		if (await this.#publishedJournalMatches(journal)) {
			await this.#removeJournal(journalPath);
			return;
		}
		try {
			await dependencies.fs.lstat(journal.entryDir);
			this.#markUnhealthy(journal.id, [journalPath, journal.entryDir], "published entry does not match transaction");
			return;
		} catch (error) {
			if (!isMissingFile(error)) {
				this.#markUnhealthy(journal.id, [journalPath, journal.entryDir], "cannot inspect published entry");
				return;
			}
		}
		try {
			await this.#assertSameDevice([journal.stageDir], journal.device);
		} catch {
			this.#markUnhealthy(journal.id, [journalPath, journal.stageDir], "mismatched device");
			return;
		}

		const locations = await Promise.all(
			journal.files.map(async file => ({
				file,
				active: await this.#fileState(file.source, file.identity),
				staged: await this.#fileState(file.staged, file.identity),
			})),
		);
		for (const location of locations) {
			if (location.active === "mismatch" || location.staged === "mismatch") {
				this.#markUnhealthy(
					journal.id,
					[journalPath, location.file.source, location.file.staged],
					"mismatched file",
				);
				return;
			}
			if (location.active === "match" && location.staged === "match") {
				this.#markUnhealthy(
					journal.id,
					[journalPath, location.file.source, location.file.staged],
					"file collision",
				);
				return;
			}
			if (location.active === "missing" && location.staged === "missing") {
				this.#markUnhealthy(journal.id, [journalPath, location.file.source, location.file.staged], "missing file");
				return;
			}
		}
		if (locations.every(location => location.active === "missing" && location.staged === "match")) {
			try {
				await this.#completeJournal(journal, journalPath);
			} catch {
				this.#markUnhealthy(journal.id, [journalPath, journal.stageDir, journal.entryDir], "failed finalization");
			}
			return;
		}
		try {
			for (const location of [...locations].reverse()) {
				if (location.staged !== "match") continue;
				await dependencies.barrier?.("before-rollback-rename");
				if ((await this.#fileState(location.file.source, location.file.identity)) !== "missing") {
					throw new Error(`Rollback source collision for transaction ${journal.id}`);
				}
				await this.#renameNoReplace(location.file.staged, location.file.source);
				await dependencies.fs.sync(path.dirname(location.file.staged));
				await dependencies.fs.sync(path.dirname(location.file.source));
			}
			await this.#removeJournal(journalPath);
		} catch {
			this.#markUnhealthy(journal.id, [journalPath, journal.stageDir], "failed rollback");
		}
	}

	#parseJournal(value: unknown): ArchiveJournal {
		if (
			typeof value !== "object" ||
			value === null ||
			(value as { version?: unknown }).version !== 1 ||
			typeof (value as { id?: unknown }).id !== "string" ||
			typeof (value as { nonce?: unknown }).nonce !== "string" ||
			typeof (value as { device?: unknown }).device !== "number" ||
			typeof (value as { stageDir?: unknown }).stageDir !== "string" ||
			typeof (value as { entryDir?: unknown }).entryDir !== "string" ||
			!Array.isArray((value as { files?: unknown }).files)
		) {
			throw new Error("Invalid archive transaction journal");
		}
		const journal = value as ArchiveJournal;
		if (
			journal.files.length < 2 ||
			!journal.files.every(
				file =>
					typeof file.source === "string" &&
					typeof file.staged === "string" &&
					typeof file.destination === "string" &&
					Number.isSafeInteger(file.identity.dev) &&
					Number.isSafeInteger(file.identity.ino) &&
					Number.isSafeInteger(file.identity.size) &&
					Number.isFinite(file.identity.mtimeMs),
			) ||
			typeof journal.manifest !== "object" ||
			journal.manifest === null ||
			journal.manifest.id !== journal.id ||
			!Array.isArray(journal.manifest.spills)
		) {
			throw new Error("Invalid archive transaction journal");
		}
		return journal;
	}

	#journalPathsAreSafe(journal: ArchiveJournal): boolean {
		const archiveRoot = path.join(this.parentArtifactsDir, ".fanout-archive");
		const stageDir = path.join(archiveRoot, ".staging", `${journal.id}.${journal.nonce}`);
		const entryDir = path.join(archiveRoot, "entries", journal.id);
		if (
			!journal.id ||
			!journal.nonce ||
			journal.id === "." ||
			journal.id === ".." ||
			journal.id.includes("/") ||
			journal.id.includes("\\") ||
			journal.nonce.includes("/") ||
			journal.nonce.includes("\\") ||
			journal.stageDir !== stageDir ||
			journal.entryDir !== entryDir ||
			journal.manifest.version !== 1 ||
			journal.manifest.transcript !== `${journal.id}.jsonl` ||
			journal.manifest.tombstone !== `${journal.id}.jsonl.tombstone` ||
			!Number.isSafeInteger(journal.manifest.bytes) ||
			journal.manifest.bytes < 0 ||
			!Number.isFinite(journal.manifest.terminalAt) ||
			!Number.isFinite(journal.manifest.archivedAt)
		) {
			return false;
		}
		const seenSources = new Set<string>();
		for (const [index, file] of journal.files.entries()) {
			const sourceName = path.basename(file.source);
			const relativeDestination =
				index === 0
					? `${journal.id}.jsonl`
					: index === 1
						? `${journal.id}.jsonl.tombstone`
						: path.join("spills", sourceName);
			const expectedSource =
				index === 0
					? path.join(this.parentArtifactsDir, `${journal.id}.jsonl`)
					: index === 1
						? path.join(this.parentArtifactsDir, `${journal.id}.jsonl.tombstone`)
						: path.join(this.parentArtifactsDir, sourceName);
			if (
				!sourceName ||
				sourceName === "." ||
				sourceName === ".." ||
				file.source !== expectedSource ||
				file.staged !== path.join(stageDir, relativeDestination) ||
				file.destination !== path.join(entryDir, relativeDestination) ||
				seenSources.has(file.source)
			) {
				return false;
			}
			seenSources.add(file.source);
		}
		return (
			journal.manifest.spills.length === journal.files.length - 2 &&
			journal.manifest.spills.every(
				(spill, index) => spill === path.join("spills", path.basename(journal.files[index + 2]?.source ?? "")),
			)
		);
	}

	async #publishedJournalMatches(journal: ArchiveJournal): Promise<boolean> {
		const dependencies = this.#dependencies;
		if (!dependencies) return false;
		try {
			const manifest = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(
					await dependencies.fs.readFile(path.join(journal.entryDir, "manifest.json")),
				),
			);
			if (JSON.stringify(manifest) !== JSON.stringify(journal.manifest)) return false;
			return (await Promise.all(journal.files.map(file => this.#fileState(file.destination, file.identity)))).every(
				state => state === "match",
			);
		} catch {
			return false;
		}
	}

	async #fileState(file: string, identity: ArchiveFileIdentity): Promise<"match" | "missing" | "mismatch"> {
		const dependencies = this.#dependencies;
		if (!dependencies) return "missing";
		try {
			const stat = await dependencies.fs.lstat(file);
			return isSafeRegularFile(stat) && matchesArchiveFileIdentity(stat, identity) ? "match" : "mismatch";
		} catch (error) {
			return isMissingFile(error) ? "missing" : "mismatch";
		}
	}

	async #assertSameDevice(paths: readonly string[], expectedDevice: number): Promise<void> {
		const dependencies = this.#dependencies;
		if (!dependencies) return;
		for (const candidatePath of paths) {
			const stat = await dependencies.fs.lstat(candidatePath);
			if (stat.dev !== expectedDevice) {
				throw new FanoutArchiveMoveError(
					`Fanout archive path is not on device ${expectedDevice}: ${candidatePath}`,
				);
			}
		}
	}

	async #writeAtomically(destination: string, data: string, temporaryDir = path.dirname(destination)): Promise<void> {
		const dependencies = this.#dependencies;
		if (!dependencies) return;
		const temporary = path.join(temporaryDir, `.${path.basename(destination)}.${randomUUID()}.tmp`);
		await dependencies.fs.writeFile(temporary, data, { flag: "wx" });
		await dependencies.fs.sync(temporary);
		await this.#renameNoReplace(temporary, destination);
		await dependencies.fs.sync(path.dirname(destination));
	}

	async #removeJournal(journalPath: string): Promise<void> {
		const dependencies = this.#dependencies;
		if (!dependencies) return;
		await dependencies.fs.removeJournal(journalPath);
		await dependencies.fs.sync(path.dirname(journalPath));
	}

	async #renameNoReplace(from: string, to: string): Promise<void> {
		const dependencies = this.#dependencies;
		if (!dependencies) return;
		try {
			await dependencies.fs.renameNoReplace(from, to);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "EXDEV") {
				throw new FanoutArchiveMoveError(`Cross-device rename refused from ${from} to ${to}`, { cause: error });
			}
			throw error;
		}
	}

	async #rename(from: string, to: string): Promise<void> {
		const dependencies = this.#dependencies;
		if (!dependencies) return;
		try {
			await dependencies.fs.rename(from, to);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "EXDEV") {
				throw new FanoutArchiveMoveError(`Cross-device rename refused from ${from} to ${to}`, { cause: error });
			}
			throw error;
		}
	}

	#markUnhealthy(id: string, paths: readonly string[], reason: string): void {
		if (!this.#snapshot.unhealthyTransaction) {
			this.#snapshot = {
				...this.#snapshot,
				unhealthyTransaction: { id, paths, reason },
			};
		}
	}

	async #withinMutex<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.#mutex;
		let release!: () => void;
		this.#mutex = new Promise<void>(resolve => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}
