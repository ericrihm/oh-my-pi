# Fanout Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound persistent task and Vibe fanout retention while rejecting a fanout before it creates persistent state that could exhaust the parent filesystem.

**Architecture:** A parent-scoped `FanoutArchiveManager` owns same-device archive inspection, reservations, serialized journaled moves, recovery, accounting, and observable snapshots. Task and Vibe perform one admission preflight before IDs, leases, jobs, or child processes exist; child startup claims the opaque reservation immediately before persistent state is created. Active paths remain authoritative, while the URL readers resolve an active file first and then a published, relative archive manifest.

**Tech Stack:** TypeScript, Bun, `bun:test`, Node `fs/promises`, existing `SessionManager`, `AgentRegistry`, `AgentLifecycleManager`, Vibe lifecycle journal, and internal URL protocol handlers.

## Global Constraints

- Keep the active parent JSONL and parent-owned artifacts at their existing paths; never archive them.
- Archive only direct persistent child JSONLs whose durable sidecar is `<child>.jsonl.tombstone` and whose in-memory state is terminal `aborted` with no live, parked, idle, running, pending-revival, or Vibe-rehydratable reference.
- Do not alter child JSONL bytes, parent JSONL format, child summary (`<child>.md`) format/location, branch metadata, patch artifacts, lifecycle entries, compaction entries, or the existing GC archive format.
- Archive only child-owned, completed, referenced spill logs. Unknown, parent-owned, active-child, open, symlinked, hard-linked, ambiguous, or unreferenced files remain active.
- Archive under `<parent-artifacts-dir>/.fanout-archive/` only. Require matching `st_dev`; `EXDEV` and cross-device placement are hard errors. Never copy, compress, link-replace, unlink-as-fallback, or delete archive data.
- Archive manifests contain no absolute paths and retain source-relative/archive-relative names, terminal marker, spill names, byte counts, archive timestamp, and transaction version.
- The archive’s byte limit is logical retention only. Same-filesystem moves gain `0 B` physical free space and must never be reported as physical reclamation.
- Preflight runs once per persistent task/Vibe fanout, including one child, before child-ID allocation, artifact-directory creation, temporary-directory creation, async-job registration, child JSONL creation, or child launch. Non-persistent work retains its current temporary-artifact behavior and gets no archive reservation.
- Defaults: `enabled=true`, `archiveLimitBytes=1073741824`, `minimumFreeBytes=1073741824`, `reserveBytesPerChild=67108864`, and `strictActiveTerminalLimitBytes=0`. Normalize settings to finite non-negative integers, falling back to schema defaults.
- A failure must identify physical free space, archive capacity, unsafe recovery, cross-device placement, or active-terminal budget. Its physical-space message includes child count, free bytes, required reservation, minimum free, shortfall, archive used/limit, reclaimable active-terminal bytes, `physical free gained: 0 B`, and the documented remedy.
- No task includes a commit, push, formatter, linter, build, or implementation-time full-suite step. Create one final commit only after all final verification has passed.

## File Structure

| File                                                                                                              | Responsibility                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/coding-agent/src/session/fanout-archive.ts`                                                             | Parent-scoped configuration, filesystem adapter, terminal inspection, accounting, reservations, journaled moves, recovery, mutex, archive snapshots, and manifest-backed file resolution. |
| `packages/coding-agent/src/session/session-manager.ts`                                                            | Memoize one archive manager for the current parent artifact directory; clear it whenever the session file/artifact manager is reset or relocated.                                         |
| `packages/coding-agent/src/session/artifacts.ts`                                                                  | Use the archive-aware artifact path resolver after the active directory lookup; retain existing active allocation and write behavior.                                                     |
| `packages/coding-agent/src/tools/index.ts`, `packages/coding-agent/src/sdk.ts`                                    | Carry the parent manager through `ToolSession` without introducing a second manager per tool or child.                                                                                    |
| `packages/coding-agent/src/task/index.ts`                                                                         | Perform atomic outer task-fanout admission, pass one reservation to each child, and release unscheduled/settled claims.                                                                   |
| `packages/coding-agent/src/task/structured-subagent.ts`                                                           | Claim the reservation and repeat the lightweight physical check before `leaseArtifacts()` or child-ID allocation.                                                                         |
| `packages/coding-agent/src/vibe/runtime.ts`                                                                       | Admit Vibe spawns before ID/job creation; seal a durable child tombstone after Vibe terminal intent; refuse archive-backed revival; schedule terminal archive work only after sealing.    |
| `packages/coding-agent/src/registry/agent-lifecycle.ts`, `packages/coding-agent/src/registry/persisted-agents.ts` | Keep the existing tombstone-before-detach ordering, notify archive work only after terminal sealing, and never rediscover archive entries as parked children.                             |
| `packages/coding-agent/src/internal-urls/{artifact-protocol,history-protocol,registry-helpers}.ts`                | Resolve active transcript/spill paths first, then only published archive manifests; never expose staging paths or fabricate empty output.                                                 |
| `packages/coding-agent/src/cli/gc-cli.ts`                                                                         | Exclude `.fanout-archive/` from nested-session traversal without changing `gc --archive` behavior or its cross-device fallback implementation.                                            |
| `packages/coding-agent/src/config/settings-schema.ts`, `docs/settings.md`                                         | Define the five settings in Tasks/Subagents and document physical versus logical budgets and the three user remedies.                                                                     |
| `packages/coding-agent/test/session/fanout-archive.test.ts`                                                       | Synthetic-parent fixtures plus injected filesystem, device, free-space, registry, Vibe, clock, and barrier adapters for core archive contracts.                                           |
| `packages/coding-agent/test/task/{fanout-preflight,structured-subagent}.test.ts`                                  | Task admission/reservation behavior and final lease gate.                                                                                                                                 |
| `packages/coding-agent/test/vibe/fanout-archive.test.ts`                                                          | Vibe preflight, terminal seal, recovery, and non-revival integration contracts.                                                                                                           |
| `packages/coding-agent/test/internal-urls/{fanout-archive-reader,history-protocol,artifact-path-only}.test.ts`    | Archive-backed protocol resolution, compact-summary stability, relocation, and corruption errors.                                                                                         |
| `packages/coding-agent/test/gc-cli.test.ts`, `packages/coding-agent/test/registry/agent-lifecycle.test.ts`        | Archive traversal exclusion and terminal-seal scheduling behavior.                                                                                                                        |

## Stable Interfaces

Implement these interfaces before their consumers. `FanoutArchiveReservation` is opaque outside `fanout-archive.ts`; callers may only claim/release/settle it.

```ts
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
  writeFile(
    path: string,
    data: string | Uint8Array,
    options?: { flag?: "wx" },
  ): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
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

export class FanoutStoragePreflightError extends Error {
  readonly kind:
    | "physical-space"
    | "archive-capacity"
    | "active-terminal-limit"
    | "unsafe-recovery"
    | "cross-device";
}

export class FanoutArchiveManager {
  static forParent(
    parentArtifactsDir: string,
    dependencies?: FanoutArchiveDependencies,
  ): FanoutArchiveManager;
  preflight(request: FanoutPreflightRequest): Promise<FanoutArchiveReservation>;
  archiveTerminalChildren(): Promise<FanoutArchiveSnapshot>;
  recover(): Promise<void>;
  snapshot(): FanoutArchiveSnapshot;
  resolveArchivedTranscript(childId: string): Promise<string | undefined>;
  resolveArchivedArtifact(artifactId: string): Promise<string | undefined>;
}
```

`FanoutArchiveDependencies` is test-only injectable I/O for `stat`, `lstat`, `statfs`, `readdir`, `readFile`, `writeFile`, `mkdir`, `rename`, and journal removal; production supplies Node APIs. It also supplies registry/Vibe liveness lookups, a clock, and optional barrier hooks. Its interface intentionally has no copy, compression, hard-link, or data-delete operation.

---

### Task 1: Establish settings, parent ownership, and monitorable archive state

**Files:**

- Create: `packages/coding-agent/src/session/fanout-archive.ts`
- Modify: `packages/coding-agent/src/session/session-manager.ts:503-508,1065-1070,1177-1192,1278-1282,1332-1335,1389-1392,1495-1497,1895-1916`
- Modify: `packages/coding-agent/src/tools/index.ts:260-269`
- Modify: `packages/coding-agent/src/sdk.ts:1760-1778`
- Modify: `packages/coding-agent/src/config/settings-schema.ts:4552-4613`
- Test: `packages/coding-agent/test/session/fanout-archive.test.ts`

**Interfaces:**

- Consumes: `SessionManager.getArtifactsDir()`, `Settings.get()`, and the five `task.fanoutArchive.*` schema keys.
- Produces: the interfaces in **Stable Interfaces**; `SessionManager.getFanoutArchiveManager(): FanoutArchiveManager | null`; and optional `ToolSession.getFanoutArchiveManager?: () => FanoutArchiveManager | null`.

- [ ] **Step 1: Write the failing settings/ownership test**

```ts
it("normalizes fanout archive settings and keeps one manager per current parent directory", () => {
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
  expect(manager.getFanoutArchiveManager()).toBe(
    manager.getFanoutArchiveManager(),
  );
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `bun test packages/coding-agent/test/session/fanout-archive.test.ts -t "normalizes fanout archive settings"`

Expected: FAIL because `fanoutArchiveSettings` and `SessionManager.getFanoutArchiveManager` do not exist.

- [ ] **Step 3: Implement the minimum ownership/configuration surface**

```ts
export function fanoutArchiveSettings(
  settings: Settings,
): FanoutArchiveSettings {
  return {
    enabled: settings.get("task.fanoutArchive.enabled"),
    archiveLimitBytes: finiteNonNegative(
      settings.get("task.fanoutArchive.archiveLimitBytes"),
      1_073_741_824,
    ),
    minimumFreeBytes: finiteNonNegative(
      settings.get("task.fanoutArchive.minimumFreeBytes"),
      1_073_741_824,
    ),
    reserveBytesPerChild: finiteNonNegative(
      settings.get("task.fanoutArchive.reserveBytesPerChild"),
      67_108_864,
    ),
    strictActiveTerminalLimitBytes: finiteNonNegative(
      settings.get("task.fanoutArchive.strictActiveTerminalLimitBytes"),
      0,
    ),
  };
}
```

Add the five schema entries in `tab: "tasks", group: "Subagents"` with the specified defaults and precise logical/physical descriptions. Cache one `FanoutArchiveManager` by `getArtifactsDir()` in `SessionManager`, clear it with every existing artifact-manager reset/relocation, and expose it through the SDK `ToolSession` bridge. Implement `snapshot()` with zero accounting and a typed unhealthy transaction field; this snapshot plus structured `logger.info`/`logger.warn` events is the monitoring surface, not a new UI or telemetry system.

- [ ] **Step 4: Run the focused GREEN command**

Run: `bun test packages/coding-agent/test/session/fanout-archive.test.ts -t "normalizes fanout archive settings"`

Expected: PASS; invalid numeric values are defaults and repeated access returns the same manager for one parent directory.

### Task 2: Prove terminal eligibility and deterministic accounting before any move

**Files:**

- Modify: `packages/coding-agent/src/session/fanout-archive.ts`
- Test: `packages/coding-agent/test/session/fanout-archive.test.ts`

**Interfaces:**

- Consumes: `FanoutArchiveManager`, registry references, Vibe restore-state lookup, direct child files in the parent directory, and `FanoutArchiveSettings` from Task 1.
- Produces: internal `TerminalChildInspector.inspect(childId): Promise<TerminalArchiveCandidate | undefined>` and `FanoutArchiveManager.snapshot()` values with deterministic candidate order.

- [ ] **Step 1: Write the failing classification/accounting test**

```ts
it("selects only stable tombstoned aborted children oldest first and counts only owned completed spills", async () => {
  const fixture = await parentFixture({
    children: [
      abortedChild("Old", { terminalAt: 10, spills: ["17.bash.log"] }),
      abortedChild("New", { terminalAt: 20, spills: ["18.read.log"] }),
      liveChild("Idle", "idle"),
      liveChild("Parked", "parked"),
      vibeRevivableChild("Vibe"),
    ],
    unknownSpills: ["19.bash.log"],
  });
  const manager = fixture.manager({ archiveLimitBytes: 100_000 });
  await manager.archiveTerminalChildren();
  expect(fixture.publishedIds()).toEqual(["Old", "New"]);
  expect(fixture.activeFiles()).toContain("19.bash.log");
  expect(manager.snapshot().archiveUsedBytes).toBe(
    fixture.bytesOfPublishedEntries(),
  );
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `bun test packages/coding-agent/test/session/fanout-archive.test.ts -t "selects only stable tombstoned aborted children"`

Expected: FAIL because no inspector, manifest accounting, or archive candidate ordering exists.

- [ ] **Step 3: Implement the minimum inspector and accounting rules**

Add a private inspector that accepts only direct `<id>.jsonl` entries with matching `<id>.jsonl.tombstone`, a matching/uncontested `aborted` registry reference, no Vibe restoration candidate, regular unlinked sources, and an unchanged stat fence (`dev`, `ino`, `size`, `mtimeMs`, `ctimeMs`) around JSONL parsing. Parse only enough JSONL to identify completed spill IDs attributable to that child; reject the entire candidate on malformed JSONL, open-writer evidence, unresolved ownership, source escape, symlink, hard link (`nlink !== 1`), duplicate manifest, or existing destination. Sort by terminal timestamp, transcript mtime, and child ID. Compute published archive bytes, eligible active-terminal bytes, and reclaimable bytes bounded by remaining archive capacity; leave all non-candidates untouched.

- [ ] **Step 4: Run the focused GREEN command**

Run: `bun test packages/coding-agent/test/session/fanout-archive.test.ts -t "selects only stable tombstoned aborted children"`

Expected: PASS; `Old` precedes `New`, every revivable/unknown file remains active, and accounting counts only published candidate files.

### Task 3: Publish only complete same-device entries and recover every interruption safely

**Files:**

- Modify: `packages/coding-agent/src/session/fanout-archive.ts`
- Test: `packages/coding-agent/test/session/fanout-archive.test.ts`

**Interfaces:**

- Consumes: `TerminalArchiveCandidate` and accounting from Task 2.
- Produces: durable `.fanout-archive/.txn/<id>.<nonce>.json` journals; atomically published `entries/<id>/manifest.json`; `recover(): Promise<void>`; and a per-parent async mutex used by moves, recovery, and archive reads.

- [ ] **Step 1: Write the failing atomic recovery test**

```ts
it.each([
  "before-first-rename",
  "after-transcript-rename",
  "after-spill-rename",
  "before-manifest",
])("recovers %s without copy/delete fallback", async (failurePoint) => {
  const fixture = await parentFixture({
    children: [abortedChild("Dead", { spills: ["17.bash.log"] })],
  });
  fixture.files.failAt(failurePoint);
  await expect(fixture.manager().archiveTerminalChildren()).rejects.toThrow();
  await fixture.restartManager().recover();
  expect(fixture.hasOnlyCompleteActiveOrPublishedEntry("Dead")).toBe(true);
  expect(fixture.files.copyCalls).toBe(0);
  expect(fixture.files.unlinkCallsForData).toBe(0);
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `bun test packages/coding-agent/test/session/fanout-archive.test.ts -t "recovers.*without copy/delete fallback"`

Expected: FAIL because transactions, staging, recovery, and injected failure points do not exist.

- [ ] **Step 3: Implement the journaled move protocol and recovery state machine**

Inside the mutex, recheck liveness and the inspection fence; verify all source and planned archive roots share `st_dev`; write and atomically publish the journal before any rename; rename sources into `.staging/<id>.<nonce>/`; write `manifest.json`; atomically rename the complete staging directory to `entries/<id>/`; then remove only the journal. Implement recovery exactly as follows: remove a journal only when a published manifest and all expected final files match; finalize a complete staged set only when every active source is absent and journal checks match; roll incomplete unambiguous sets back by same-device rename only into absent original paths; mark collision, missing-file, mismatched-device, or failed rollback transactions unhealthy without deleting either copy. Reject new persistent preflight while any transaction is unhealthy. Handle `EXDEV` as a typed failure and never invoke a copy, link, compression, or source-unlink fallback.

- [ ] **Step 4: Run the focused GREEN command**

Run: `bun test packages/coding-agent/test/session/fanout-archive.test.ts -t "recovers.*without copy/delete fallback"`

Expected: PASS at all four interruption points; restart recovery leaves exactly one complete active or published representation and preserves every journal ambiguity.

### Task 4: Preserve stable reader identities and exclude private archive paths from discovery/GC

**Files:**

- Modify: `packages/coding-agent/src/session/fanout-archive.ts`
- Modify: `packages/coding-agent/src/session/artifacts.ts:122-153`
- Modify: `packages/coding-agent/src/internal-urls/artifact-protocol.ts:38-96,134-150`
- Modify: `packages/coding-agent/src/internal-urls/history-protocol.ts:75-147`
- Modify: `packages/coding-agent/src/internal-urls/registry-helpers.ts:50-92`
- Modify: `packages/coding-agent/src/registry/persisted-agents.ts:312-423`
- Modify: `packages/coding-agent/src/cli/gc-cli.ts:23-25,236-245,368-384`
- Test: `packages/coding-agent/test/internal-urls/fanout-archive-reader.test.ts`
- Test: `packages/coding-agent/test/internal-urls/history-protocol.test.ts`
- Test: `packages/coding-agent/test/internal-urls/artifact-path-only.test.ts`
- Test: `packages/coding-agent/test/gc-cli.test.ts`

**Interfaces:**

- Consumes: published manifests and the parent-scoped resolver from Tasks 2–3.
- Produces: active-first `history://<id>` and `artifact://<numeric-id>` paths; read-only archived transcripts; archive-corruption errors; and scans that exclude `.fanout-archive/`.

- [ ] **Step 1: Write the failing reader compatibility test**

```ts
it("keeps compact history and artifact identities stable after terminal archival and relocation", async () => {
  const fixture = await archivedParentFixture("Dead", {
    summary: "compact",
    spill: ["17.bash.log", "raw spill"],
  });
  await fixture.relocateParent();
  await expect(
    resolveHistory("history://Dead", fixture.context),
  ).resolves.toContain("child transcript");
  await expect(
    resolveArtifact("artifact://17", fixture.context),
  ).resolves.toMatchObject({
    sourcePath: expect.stringContaining("entries/Dead/spills/17.bash.log"),
  });
  expect(await Bun.file(fixture.activePath("Dead.md")).text()).toBe("compact");
  expect(await fixture.discoveredActiveIds()).not.toContain("Dead");
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `bun test packages/coding-agent/test/internal-urls/fanout-archive-reader.test.ts -t "keeps compact history and artifact identities stable"`

Expected: FAIL because readers scan only active paths and no manifest-relative archive lookup exists.

- [ ] **Step 3: Implement active-first archive-backed resolution and exclusions**

Make `ArtifactManager.getPath`, `resolveArtifactFile`, artifact completion, `sessionFilesFromDisk`, and history’s disk fallback ask the parent manager for a published-manifest match only after the active file misses. Preserve `<id>.md` as the first compact history choice and do not move it. Readers acquire the archive mutex, never expose `.staging` or journals, rebuild their in-memory artifact-ID index after `recover()`, and return a specific archive-corruption error if a manifest is missing/malformed and no active file exists. Keep archived `aborted` refs non-revivable; skip archive directories in persisted child registration and generic recursive transcript discovery. Replace GC’s unrestricted JSONL recursive collection with traversal that explicitly prunes `.fanout-archive` while leaving the existing GC archive layout and its separate move implementation unchanged.

- [ ] **Step 4: Run the focused GREEN command**

Run: `bun test packages/coding-agent/test/internal-urls/fanout-archive-reader.test.ts packages/coding-agent/test/internal-urls/history-protocol.test.ts packages/coding-agent/test/internal-urls/artifact-path-only.test.ts packages/coding-agent/test/gc-cli.test.ts`

Expected: PASS; history, Agent Hub transcript reads, compact summaries, and numeric artifacts retain their public identifiers, while malformed archive data is explicit and GC/discovery do not treat archive content as active sessions.

### Task 5: Add atomic outer task admission, actionable rejection, and reservation accounting

**Files:**

- Modify: `packages/coding-agent/src/task/index.ts:696-924,1238-1365,1418-1451`
- Modify: `packages/coding-agent/src/tools/index.ts:260-269`
- Test: `packages/coding-agent/test/task/fanout-preflight.test.ts`
- Test: `packages/coding-agent/test/task/task-preflight.test.ts`

**Interfaces:**

- Consumes: `ToolSession.getFanoutArchiveManager()`, `fanoutArchiveSettings()`, `FanoutArchiveManager.preflight()`, and `FanoutArchiveReservation` from Task 1.
- Produces: a single shared `FanoutArchiveReservation` passed in every task child’s `StructuredSubagentRequest`; and release calls for scheduling failure, cancellation, and child settlement.

- [ ] **Step 1: Write the failing task admission test**

```ts
it("rejects a persistent batch before allocating IDs, artifact directories, or async jobs when physical space is short", async () => {
  const { tool, outputManager, archive, jobs } = await taskFixture({
    archive: preflightRejecting("physical-space", {
      filesystemFreeBytes: 820 * MiB,
      childCount: 24,
    }),
  });
  const result = await tool.execute("fanout", {
    context: "shared",
    tasks: twentyFourTasks(),
  });
  expect(textOf(result)).toContain(
    "Fanout storage preflight rejected 24 children:",
  );
  expect(textOf(result)).toContain("physical free gained: 0 B");
  expect(outputManager.allocate).not.toHaveBeenCalled();
  expect(jobs.register).not.toHaveBeenCalled();
  expect(archive.createdPaths).toEqual([]);
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `bun test packages/coding-agent/test/task/fanout-preflight.test.ts -t "rejects a persistent batch before allocating IDs"`

Expected: FAIL because `TaskTool` has no storage preflight and allocates IDs before checking storage.

- [ ] **Step 3: Implement one fanout-level admission gate**

After policy resolution succeeds for every task item but before the async/sync branch, output-manager allocation, semaphore work, or job registration, detect a persistent parent through `session.getSessionFile()`. Call `preflight({ childCount: spawnItems.length, settings: fanoutArchiveSettings(session.settings) })` once, format `FanoutStoragePreflightError` unchanged into task error output, and attach the returned reservation to every async and synchronous spawn request. On scheduling failure call `releaseUnclaimedChild`; on cancelled-before-start and settled child paths release/settle exactly once. A non-persistent parent bypasses archive reservation and preserves existing temporary behavior. Treat strict active-terminal overflow as a rejection; if strict mode is off, surface archive-full capacity as a warning but allow a physically safe request.

- [ ] **Step 4: Run the focused GREEN command**

Run: `bun test packages/coding-agent/test/task/fanout-preflight.test.ts packages/coding-agent/test/task/task-preflight.test.ts`

Expected: PASS; physical, cross-device, unsafe-recovery, strict-budget, and archive-capacity messages are actionable, and a failed request creates no IDs, directories, jobs, JSONLs, or child processes.

### Task 6: Gate persistent child creation behind the reservation’s final check

**Files:**

- Modify: `packages/coding-agent/src/task/structured-subagent.ts:82-117,329-363,547-670`
- Test: `packages/coding-agent/test/task/structured-subagent.test.ts`

**Interfaces:**

- Consumes: `FanoutArchiveReservation` from Task 5.
- Produces: `StructuredSubagentRequest.fanoutReservation?: FanoutArchiveReservation`; `claimChild()` before `leaseArtifacts()` and `reserveStructuredSubagentId()`; and one matching `settleChild()`/`releaseUnclaimedChild()` lifecycle call.

- [ ] **Step 1: Write the failing final-gate test**

```ts
it("does not lease artifacts or allocate a child ID when the reservation's final free-space check rejects", async () => {
  const reservation = rejectingReservation(
    "Fanout storage preflight rejected 1 children:",
  );
  const mkdir = vi.spyOn(fs, "mkdir");
  const allocate = vi.spyOn(AgentOutputManager.prototype, "allocate");
  await expect(
    runStructuredSubagent(request({ fanoutReservation: reservation })),
  ).rejects.toThrow("Fanout storage preflight rejected");
  expect(mkdir).not.toHaveBeenCalled();
  expect(allocate).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `bun test packages/coding-agent/test/task/structured-subagent.test.ts -t "does not lease artifacts or allocate a child ID"`

Expected: FAIL because `runStructuredSubagent()` calls `leaseArtifacts()` before child reservation handling exists.

- [ ] **Step 3: Implement claim/settlement ordering**

Add the optional opaque reservation to `StructuredSubagentRequest`. Preserve policy resolution first. Then claim the reservation, which repeats a lightweight `statfs` check before any persistent `mkdir`; only after a successful claim call `leaseArtifacts()` and `reserveStructuredSubagentId()`. In `finally`, settle a started claim or release an unclaimed one on cancellation/error. Do not reserve temporary eval/task artifact directories and do not alter current isolated-subagent cleanup semantics.

- [ ] **Step 4: Run the focused GREEN command**

Run: `bun test packages/coding-agent/test/task/structured-subagent.test.ts -t "does not lease artifacts or allocate a child ID"`

Expected: PASS; the final gate prevents both artifact leasing and ID allocation, while existing temporary and isolation cleanup contracts remain unchanged.

### Task 7: Integrate Vibe admission, terminal sealing, and archive-safe rehydration

**Files:**

- Modify: `packages/coding-agent/src/vibe/runtime.ts:720-736,780-817,819-931,933-1017,1204-1390,1393-1426,1503-1518`
- Modify: `packages/coding-agent/src/registry/agent-lifecycle.ts:360-412`
- Modify: `packages/coding-agent/src/registry/persisted-agents.ts:282-423`
- Test: `packages/coding-agent/test/vibe/fanout-archive.test.ts`
- Test: `packages/coding-agent/test/registry/agent-lifecycle.test.ts`

**Interfaces:**

- Consumes: Task 1 manager/reservation APIs and Vibe’s durable parent lifecycle events.
- Produces: Vibe records carrying an optional reservation until first-turn startup, a matching child tombstone sidecar after terminal intent is durable, `archiveTerminalChildren()` scheduling after seal, and `rehydrate()` refusal for published archive children.

- [ ] **Step 1: Write the failing Vibe terminal test**

```ts
it("preflights Vibe before ID/job creation and archives only after a durable terminal sidecar seals the child", async () => {
  const fixture = await vibeFixture({ archive: acceptingArchive() });
  await fixture.registry.spawn(fixture.session, {
    cli: "fast",
    name: "Dead",
    prompt: "work",
  });
  await fixture.registry.kill(fixture.session, "Dead");
  expect(fixture.events()).toContainEqual(
    expect.objectContaining({ action: "tombstone" }),
  );
  expect(await fixture.exists("Dead.jsonl.tombstone")).toBe(true);
  await fixture.archiveDrained();
  expect(await fixture.exists(".fanout-archive/entries/Dead/Dead.jsonl")).toBe(
    true,
  );
  expect(await fixture.registry.rehydrate(fixture.session)).toBe(0);
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `bun test packages/coding-agent/test/vibe/fanout-archive.test.ts -t "preflights Vibe before ID/job creation"`

Expected: FAIL because Vibe has no archive preflight/reservation, does not create the child tombstone sidecar, and may rehydrate a terminal child from its active path.

- [ ] **Step 3: Implement Vibe’s matching lifecycle integration**

In `#spawnLocked`, resolve policy and call one persistent-child preflight before `agentOutputManager.allocate`, lifecycle spawn persistence, `#registerTurnJob`, or child path creation; release it on scheduling failure. Claim it in `#buildSpawnOptions` before `fs.mkdir`. After Vibe writes and verifies the parent tombstone lifecycle event, atomically create `<child>.jsonl.tombstone` before turning the registry ref into durable `aborted`; then schedule archive work. Make `#resolvePersistedChild` and `rehydrate` query the archive manager first: a published terminal entry is not a Vibe restore candidate and is never registered as `parked`. Preserve all current Vibe parent journal records and do not archive a worker while a turn, revival, or lifecycle event is in flight.

- [ ] **Step 4: Run the focused GREEN command**

Run: `bun test packages/coding-agent/test/vibe/fanout-archive.test.ts packages/coding-agent/test/registry/agent-lifecycle.test.ts`

Expected: PASS; Vibe rejects safely before work starts, seals terminal state before archival, retains readable terminal history, and never recreates an archived worker as revivable.

### Task 8: Seal ordinary task terminal transitions and document the operational contract

**Files:**

- Modify: `packages/coding-agent/src/registry/agent-lifecycle.ts:360-412`
- Modify: `packages/coding-agent/src/registry/persisted-agents.ts:282-423`
- Modify: `packages/coding-agent/src/config/settings-schema.ts:4552-4613`
- Modify: `docs/settings.md:740-756`
- Test: `packages/coding-agent/test/registry/agent-lifecycle.test.ts`
- Test: `packages/coding-agent/test/session/fanout-archive.test.ts`

**Interfaces:**

- Consumes: `AgentLifecycleManager.release(..., { tombstone: true })`, the manager from Task 1, and archive recovery/move semantics from Task 3.
- Produces: a post-seal archive schedule hook that cannot run for `running`, `idle`, `parked`, ordinary release, or an unpersisted tombstone; documented five-setting contract and snapshot/error meanings.

- [ ] **Step 1: Write the failing terminal-seal scheduling test**

```ts
it("schedules archive work only after a successful tombstone write and never for revivable releases", async () => {
  const archive = {
    archiveTerminalChildren: vi.fn().mockResolvedValue(undefined),
  };
  const { lifecycle, registry } = lifecycleFixture({ archive });
  await lifecycle.release("Live", registry.get("Live"));
  expect(archive.archiveTerminalChildren).not.toHaveBeenCalled();
  await lifecycle.release("Dead", registry.get("Dead"), { tombstone: true });
  expect(archive.archiveTerminalChildren).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `bun test packages/coding-agent/test/registry/agent-lifecycle.test.ts -t "schedules archive work only after a successful tombstone write"`

Expected: FAIL because lifecycle terminal sealing has no archive scheduling dependency.

- [ ] **Step 3: Implement the post-seal hook and settings documentation**

Inject or register an optional parent archive scheduler with lifecycle ownership rather than importing session-specific state into generic registry code. Invoke it only after `persistAgentTombstone()` succeeds, status is durably `aborted`, and the session is detached; preserve tombstone write errors and do not schedule on them. Ensure persisted discovery leaves archived entries absent from active scans and preserves an existing `aborted` ref rather than converting it to `parked`. In `docs/settings.md`, add a fanout-archive table with all defaults, state that archive bytes are logical retention and free-space/reservation bytes are physical headroom, explain `0` semantics, show the exact remedy choices, and state archive movement gains `0 B` physical free space.

- [ ] **Step 4: Run the focused GREEN command**

Run: `bun test packages/coding-agent/test/registry/agent-lifecycle.test.ts packages/coding-agent/test/session/fanout-archive.test.ts -t "schedules archive work only after a successful tombstone write"`

Expected: PASS; only a sealed terminal child schedules archival and no revivable registry state becomes movable.

### Task 9: Prove recovery races and high-fanout bounds, then perform final verification and cross-family review

**Files:**

- Modify: `packages/coding-agent/test/session/fanout-archive.test.ts`
- Modify: `packages/coding-agent/test/task/fanout-preflight.test.ts`
- Modify: `packages/coding-agent/test/vibe/fanout-archive.test.ts`
- Modify: `packages/coding-agent/test/internal-urls/fanout-archive-reader.test.ts`

**Interfaces:**

- Consumes: all prior production interfaces.
- Produces: deterministic barrier-driven race/stress coverage and a review handoff packet describing the final diff, commands, and remaining risk surface.

- [ ] **Step 1: Write the failing concurrency/high-fanout test**

```ts
it("keeps active or revivable children authoritative during archive races at and above max concurrency", async () => {
  const fixture = await highFanoutFixture({
    count: 65,
    maxConcurrency: 32,
    repeatedNames: true,
    nestedChildren: true,
  });
  await fixture.runWithBarriers({
    concurrentReaders: true,
    raceTransitions: [
      "append",
      "revive",
      "park",
      "vibe-lifecycle",
      "spill-writer",
    ],
  });
  expect(fixture.assertions()).toEqual({
    duplicateIds: 0,
    lostTranscriptEntries: 0,
    danglingManifests: 0,
    crossDeviceFallbacks: 0,
    tempArtifactsAfterRejectedPreflight: 0,
    activeOrRevivableMoved: 0,
    archiveUsedWithinLimit: true,
  });
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `bun test packages/coding-agent/test/session/fanout-archive.test.ts -t "keeps active or revivable children authoritative"`

Expected: FAIL until the race barriers, archive mutex, liveness rechecks, reservation composition, and reader synchronization implemented in Tasks 1–8 are all connected.

- [ ] **Step 3: Complete race/stress coverage and fix only demonstrated gaps**

Use injected barriers to cover append-vs-archive, revive-vs-archive, lifecycle-transition-vs-archive, and spill-writer-vs-archive, asserting the active/revivable side wins. Add restart cases for committed, complete staged, partial, collision, missing-file, and unrecoverable journal states. Add mixed sync/async task and Vibe fanout at `task.maxConcurrency` and one above it, with large owned spills, repeated IDs, nested children, concurrent `history://`/`artifact://` reads, archive-limit exhaustion, strict active-terminal enforcement, and preflight rejection. Assertions must verify bounded accounting, no duplicate IDs, no lost JSONL byte sequences, no dangling manifests, no cross-device fallback, and no child/temp/job artifacts after rejection.

- [ ] **Step 4: Run targeted stress GREEN verification**

Run: `bun test packages/coding-agent/test/session/fanout-archive.test.ts packages/coding-agent/test/task/fanout-preflight.test.ts packages/coding-agent/test/vibe/fanout-archive.test.ts packages/coding-agent/test/internal-urls/fanout-archive-reader.test.ts`

Expected: PASS; all injected recovery and high-fanout invariants hold without host-disk-pressure dependency.

- [ ] **Step 5: Run final verification, then request a cross-family review before the one final commit**

Run:

```bash
bun test packages/coding-agent/test/session/fanout-archive.test.ts \
  packages/coding-agent/test/task/fanout-preflight.test.ts \
  packages/coding-agent/test/task/structured-subagent.test.ts \
  packages/coding-agent/test/vibe/fanout-archive.test.ts \
  packages/coding-agent/test/internal-urls/fanout-archive-reader.test.ts \
  packages/coding-agent/test/internal-urls/history-protocol.test.ts \
  packages/coding-agent/test/internal-urls/artifact-path-only.test.ts \
  packages/coding-agent/test/registry/agent-lifecycle.test.ts \
  packages/coding-agent/test/gc-cli.test.ts
bun --cwd=packages/coding-agent run check:types
bun run ci:test:coding-agent:heavy
```

Expected: all commands exit `0`. After the final diff and these exact outputs are available, dispatch a `regulus-review`/cross-family reviewer that did not implement the change. Give it the approved design path, changed-file list, test outputs, and these review questions: can a live/revivable transcript or active spill move; can `EXDEV` ever reach a copy/delete fallback; can recovery lose or fabricate data; can archive manifests break relocation/public readers; and can preflight create state before rejecting? Resolve only verified findings, rerun the affected focused tests and this final verification block, then create the user-required single final commit and push.

## Plan Self-Review

- **Spec coverage:** Tasks 1–3 cover settings, monitoring snapshots, same-device storage, terminal classification, accounting, journals, move serialization, recovery, and no-copy/no-delete semantics. Task 4 covers stable summaries, transcript/artifact readers, relocation, archive corruption, discovery, and GC exclusion. Tasks 5–6 cover preflight ordering, actionable physical/logical errors, reservations, cancellation/scheduling release, and final child creation checks. Tasks 7–8 cover Vibe and ordinary lifecycle sealing, active/revivable preservation, and settings documentation. Task 9 covers all stated stress, concurrency, restart, reader, and final verification requirements.
- **Placeholder scan:** None found. Each task names concrete files, a specific failing behavioral test, RED reason, implementation interface/ordering, and a targeted GREEN command.
- **Type consistency:** `FanoutArchiveManager`, `FanoutArchiveSettings`, `FanoutArchiveReservation`, `FanoutPreflightRequest`, `FanoutArchiveSnapshot`, and `FanoutStoragePreflightError` are defined once above and used with the same names and responsibilities in every dependent task.
- **Command realism:** Targeted commands use Bun’s established test runner and repository paths. Package type verification uses the existing `packages/coding-agent` `check:types` script; final heavy verification uses the root `ci:test:coding-agent:heavy` script.

## Execution Handoff

Plan complete at `docs/superpowers/plans/2026-08-10-fanout-resilience.md`. Execute tasks in order because Tasks 2–9 consume the stable archive interfaces introduced in Task 1. Do not commit or push between tasks; only the final verified state may receive the one user-required commit and push.
