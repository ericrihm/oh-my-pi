# Fanout resilience design

**Status:** Approved design. This document specifies the implementation; it does not implement it.

## Goal

Bound persistent fanout retention and reject a fanout before it can exhaust its filesystem. Terminal child transcripts and their completed spilled tool logs move into a same-filesystem archive without breaking transcript, artifact, or compact-history readers.

The design applies to persistent `task` and Vibe children under a parent session artifact directory. It does not change ordinary session GC, compression, retention, provider concurrency, or temporary non-persistent runs.

## Incident evidence

The reported incident is disk pressure during large fanout. The current persistence model exposes these pressure paths:

- `runStructuredSubagent()` leases the parent artifact directory before reserving and running a child. A persistent parent creates `<parent>.jsonl/` with `mkdir(..., { recursive: true })`.
- Child transcripts live at `<parent>.jsonl/<child-id>.jsonl`. Child summaries live at `<parent>.jsonl/<child-id>.md`.
- `ArtifactManager` assigns one shared numeric artifact ID space to the parent and all subagents. Spilled tool output is written as `<artifact-id>.<tool>.log` in the same directory.
- `AgentOutputManager` reserves child IDs from top-level `.jsonl` and `.md` names. `registerPersistedSubagents()` recursively restores top-level child JSONLs as `parked` or `aborted` registry entries.
- `AgentLifecycleManager` keeps completed agents `idle`, parks them while retaining `sessionFile`, and cold-revives parked agents. An explicit kill persists `<child>.jsonl.tombstone` and records the `aborted` terminal state.
- Vibe persists spawn, turn, and tombstone lifecycle events in the parent transcript. Its recovery validates that each child still has the expected `<child-id>.jsonl` path.
- No task-level filesystem-space reservation or bounded archive preflight currently runs before child allocation and artifact-directory creation.

These are observed source properties, not a claim that every persistent child is safe to move. The design treats live and revivable content as authoritative state.

## Scope and invariants

| Invariant         | Requirement                                                                                                                                                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parent session    | Never archive the active parent JSONL or its parent-owned artifacts.                                                                                                                                                                                                  |
| Live children     | Never archive a `running`, `idle`, `parked`, or otherwise revivable child transcript.                                                                                                                                                                                 |
| Terminal children | Archive only a terminal child whose lifecycle cannot revive it. The initial eligible state is an `aborted` registry tombstone with its matching `<child>.jsonl.tombstone`; a future explicit terminal-release state may be added only with an equally durable marker. |
| Context history   | Never alter or summarize a child JSONL. Preserve all lifecycle, compaction, branch-summary, and normal entries byte-for-byte.                                                                                                                                         |
| Compact history   | Keep `<child>.md` at its existing stable path. It remains the compact `history://<id>` output when that path is used.                                                                                                                                                 |
| Spills            | Move only completed spill logs referenced by an eligible child transcript. Do not move a parent-owned, active-child, unknown-owner, open, or unreferenced log.                                                                                                        |
| Filesystem        | The archive root must be on the same device as the source. `EXDEV` is a hard error. The implementation must not copy-then-delete.                                                                                                                                     |
| Deletion          | The fanout archive never deletes data to make room. Existing GC remains separate and is the only future policy surface for explicit deletion.                                                                                                                         |

## Storage layout

For parent session `P.jsonl`, use its existing artifact directory `P/`:

```text
P.jsonl                         active parent transcript
P/
  Child.jsonl                   active or terminal child transcript
  Child.jsonl.tombstone         terminal marker, if explicitly killed
  Child.md                      stable compact history output, never moved
  17.bash.log                   parent/subagent spill log while active
  .fanout-archive/
    .txn/                       durable, recoverable move journals
    .staging/                   private pre-publication entry directories
    entries/
      Child/
        Child.jsonl             archived terminal transcript
        Child.jsonl.tombstone   archived terminal marker
        spills/
          17.bash.log           archived completed spill
        manifest.json           published child-to-spill mapping
```

The archive remains inside `P/`, so `rename()` stays on the source filesystem by construction. The archive directory is private implementation state: child discovery, session listing, and GC scans must exclude `.fanout-archive/` from active-session traversal. Existing GC must neither compress nor move archive entries.

A published manifest contains the child ID, source-relative and archive-relative names, terminal marker name, referenced spill names, byte counts, archive timestamp, and archive transaction version. It contains no absolute paths. The archive reader derives all paths from the current parent artifact directory, preserving session relocation support. It lazily indexes published manifests for artifact-ID lookup and rebuilds that in-memory index after recovery.

## Components

| Component                 | Responsibility                                                                                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FanoutArchiveManager`    | Owns archive configuration, device/free-space inspection, candidate collection, transaction recovery, move serialization, manifest publication, and archive accounting. One manager is scoped to a parent artifact directory. |
| `FanoutArchivePreflight`  | Runs before a task/Vibe fanout allocates child IDs, leases artifacts, creates temporary directories, registers async jobs, or starts a child. It returns a reservation token or a structured rejection.                       |
| `TerminalChildInspector`  | Reads only enough persisted state to prove terminal eligibility and identify child-owned completed spill logs. It rejects malformed, ambiguous, changing, or unmarked candidates.                                             |
| `ArchiveReader`           | Resolves an active path first, then a published archive manifest. It serves archived child JSONLs and spills to existing `history://` and `artifact://` consumers without exposing archive internals.                         |
| `ArchiveRecovery`         | Runs before preflight and before archive-backed reads. It resolves interrupted transactions without deleting data or guessing ownership.                                                                                      |
| Task and Vibe integration | Invoke preflight at the outer fanout boundary. Pass the reservation to child dispatch, release unused reservation bytes on scheduling failure, and schedule archive work only after terminal lifecycle sealing.               |

`FanoutArchiveManager` is not a replacement for `SessionManager` persistence locks. It coordinates archive operations and reader lookups only. `SessionManager` remains the sole writer and authoritative owner of live session JSONLs.

## Eligibility and ordering

A candidate is eligible only when all conditions hold:

1. It is a direct child JSONL under the current parent artifact directory, not the parent JSONL, advisor transcript, backup, archive file, or nested directory discovered by accident.
2. Its ID has a matching durable terminal marker and the in-memory registry either has the same `aborted` reference or cannot expose a live/revivable reference for that ID. Any `running`, `idle`, `parked`, attached session, pending revival, or Vibe restoration candidate rejects the move.
3. The child JSONL is closed and stable across an inspection fence: stat before parsing, inspect, stat again. Any size, inode, mtime, or ctime change rejects the candidate for this pass.
4. The inspector can parse the child JSONL sufficiently to identify only completed spill-log references owned by that child. A parse error, an unresolved ownership relationship, or a log with active-writer evidence leaves the JSONL and that log in place.
5. The source transcript, tombstone, and every selected spill are regular files within the parent artifact directory. Symlinks, hard-link ambiguity, path escapes, existing archive destinations, and duplicate manifest entries are hard failures.

Candidates sort by terminal timestamp, then transcript mtime, then child ID. The archive moves the oldest eligible candidates first, subject to the archive byte limit. Archive failure for one candidate leaves later candidates unmodified and reports the failed candidate.

A child that merely completed a task is not eligible while its registry state is `idle`. A parked child is not eligible. This preserves `hub`, `task` revival, Vibe rehydration, and full `history://` behavior for every live or revivable child.

## Preflight and budget semantics

Preflight occurs once for each fanout request before any child ID allocation, child JSONL creation, temporary-artifact creation, async-job registration, or child process start. A single-child request follows the same path. Non-persistent requests do not create an archive reservation, but still retain existing temporary-artifact behavior after normal subagent policy validation.

The preflight calculation has separate physical and logical values:

| Value                                    | Meaning                                                                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filesystemFreeBytes`                    | Available bytes reported for the parent artifact directory's filesystem.                                                                                                                                            |
| `minimumFreeBytes`                       | Space that must remain after the requested fanout reservation.                                                                                                                                                      |
| `requestedReservationBytes`              | `childCount × reserveBytesPerChild`, adjusted by a caller-supplied bounded estimate when available. This reserves future transcript and spill growth.                                                               |
| `archiveUsedBytes` / `archiveLimitBytes` | Bytes in published archive entries. The limit bounds archive retention, not device usage.                                                                                                                           |
| `activeTerminalBytes`                    | Eligible terminal bytes still at active paths.                                                                                                                                                                      |
| `archiveReclaimableBytes`                | Bytes that can move from active paths into remaining archive capacity. This frees active-path quota and discovery pressure. It adds **zero** filesystem free bytes because the move remains on the same filesystem. |
| `physicalShortfallBytes`                 | `minimumFreeBytes + requestedReservationBytes - filesystemFreeBytes`, floored at zero.                                                                                                                              |

Preflight first runs transaction recovery, then validates that the archive root and every planned destination share `st_dev` with the parent artifact directory. It computes archive candidates without creating a child, temp directory, journal, or destination file.

The request is rejected when `physicalShortfallBytes > 0`. It is also rejected when an existing archive transaction cannot be recovered safely, the archive root is unavailable or cross-device, or a configured strict active-terminal budget cannot be met without moving more than the remaining archive capacity. Archiving cannot turn a physical-space failure into success because same-filesystem renames do not release blocks.

On success, preflight reserves `requestedReservationBytes` in memory for this parent manager and returns an opaque token. Child startup consumes the token. The manager releases unused bytes when a child is never scheduled, a fanout cancels, or every child settles. Reservations do not reserve filesystem blocks and expire when the owning process exits; the final child creation path repeats a lightweight free-space check immediately before it creates persistent state.

A rejection is actionable and includes this stable information:

```text
Fanout storage preflight rejected 24 children:
filesystem free: 820 MiB; required reserve: 1.50 GiB; minimum free: 1.00 GiB; shortfall: 1.68 GiB
archive: used 384 MiB / limit 1.00 GiB; active-terminal reclaimable: 640 MiB (physical free gained: 0 B)
remedy: free space on this filesystem, lower task.fanoutArchive.reserveBytesPerChild only with a known smaller workload, or raise the archive limit if active-path retention is the constraint.
```

The error must state whether the failure is physical free space, archive capacity, unsafe recovery, cross-device placement, or active-terminal budget. It must not claim that archive movement frees device bytes.

## Configuration and defaults

Add these settings in the existing `task.*` schema and Tasks/Subagents UI group:

| Setting                                             | Type    |              Default | Semantics                                                                                                                           |
| --------------------------------------------------- | ------- | -------------------: | ----------------------------------------------------------------------------------------------------------------------------------- |
| `task.fanoutArchive.enabled`                        | boolean |               `true` | Enables persistent-fanout preflight and terminal archival. `false` disables archival but retains the physical free-space preflight. |
| `task.fanoutArchive.archiveLimitBytes`              | number  | `1073741824` (1 GiB) | Maximum bytes in published archive entries for one parent artifact directory. `0` disables archival moves, not preflight.           |
| `task.fanoutArchive.minimumFreeBytes`               | number  | `1073741824` (1 GiB) | Required filesystem headroom after the fanout reservation.                                                                          |
| `task.fanoutArchive.reserveBytesPerChild`           | number  |  `67108864` (64 MiB) | Conservative physical reservation for each requested persistent child, including expected transcript and spill growth.              |
| `task.fanoutArchive.strictActiveTerminalLimitBytes` | number  |                  `0` | Optional cap for eligible terminal bytes left at active paths. `0` disables this logical retention gate.                            |

Values normalize to finite non-negative integers. Invalid values use schema defaults. `archiveLimitBytes` and `strictActiveTerminalLimitBytes` are logical retention budgets. `minimumFreeBytes` and `reserveBytesPerChild` protect the real filesystem. The implementation must document these distinctions in `docs/settings.md` when it lands.

## Move protocol and concurrency

Moves use a per-parent archive mutex plus a durable transaction journal. The mutex covers candidate validation, reader resolution during a move, transaction publication, and recovery. It does not block normal active-session appends beyond the candidate's validation fence.

For each candidate:

1. Acquire the parent archive mutex. Recheck the registry and Vibe restore state.
2. Stat and inspect the transcript and selected spills. Re-stat all sources. Abort if any source changed or gained a live/revivable owner.
3. Verify the archive root and source device IDs match. Create and atomically publish `.txn/<child-id>.<nonce>.json` while all sources remain at active paths.
4. Rename each source into `.fanout-archive/.staging/<child-id>.<nonce>/`. Each rename is a same-device atomic rename. Do not write copies and do not unlink a source as a fallback.
5. Atomically rename the complete staging directory to `.fanout-archive/entries/<child-id>/`. The entry directory contains its transcript, terminal marker, all selected spills, and `manifest.json`, so publication is one directory rename.
6. Remove the transaction journal only after the entry directory is published. Update in-memory accounting and release the mutex.

The transaction journal records every source and staged destination before the first rename. Readers wait for the mutex, prefer active paths, then published manifests. They never expose a staging path. If a process dies mid-move, the next recovery reads the journal:

- A published manifest with all expected final files is committed. Recovery removes only the journal.
- A complete staged set without a manifest is finalized into its manifest when every source is absent and every file matches the journal.
- Any incomplete or ambiguous set is rolled back by same-filesystem rename to its original active path when that path is absent.
- A destination/source collision, missing file, cross-device state, or failed rollback marks the transaction unhealthy, blocks new fanout, and reports the exact paths. Recovery never deletes either copy to choose a winner.

Archive work must use `fs.rename`, not `copyFile`, stream copy, compression, link replacement, or `unlink` fallback. Existing `gc --archive` uses compression and a cross-device move fallback; this design does not reuse that behavior.

A child that transitions to `running`, `idle`, or `parked`, starts revival, appends to its JSONL, receives a Vibe lifecycle event, or gains an open spill writer during the protocol loses eligibility. The protocol aborts before the first rename when detected. If it races after a source rename, the archive mutex makes readers wait, recovery restores or finalizes only from durable evidence, and lifecycle integration refuses the transition until the transaction resolves.

## Reader and history compatibility

The public identities remain unchanged:

- `history://<id>` resolves the current parent artifact directory, checks `<id>.md` first for compact history output, and uses the active child JSONL or a published archive manifest for full transcript rendering.
- `agent://<id>` and Agent Hub transcript reads resolve active child JSONLs first, then published archive transcripts. An archived terminal child is read-only and never appears as a revivable `parked` child.
- `artifact://<id>` checks the active shared artifact directory first, then archive manifests/spill paths. The existing numeric artifact ID remains valid after its log moves.
- Parent transcript loading, branch/compaction reconstruction, and Vibe rehydration never recurse into the archive as active children. A Vibe record that requires a child in the archive is terminal-only and cannot rehydrate.
- `<id>.md`, patch artifacts, branch metadata, and lifecycle/compaction/branch-summary content remain at their existing stable locations unless a future explicit compatibility design includes them. This change moves only the terminal JSONL, tombstone, and eligible completed spill logs.

Archive lookup is read-only. A missing or malformed manifest falls back to the active path only when that file exists. Otherwise it returns a specific archive-corruption error and does not fabricate an empty transcript or log.

## Failure behavior

| Failure                      | Required behavior                                                                                                                                                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Insufficient free space      | Reject before child/temp creation with used/limit/free/reclaim/shortfall values.                                                                                                                                                                    |
| Archive full                 | Leave candidate files active. If strict active-terminal budget is off, permit fanout if physical preflight passes and emit an archive-capacity warning. If strict budget is on, reject with remaining archive capacity and active-terminal overage. |
| `EXDEV` or mismatched device | Do not move. Reject/archive-fail with source and destination devices. No copy-delete fallback.                                                                                                                                                      |
| Candidate changes or revives | Do not archive it this pass. Keep it active; retry only after a later terminal seal.                                                                                                                                                                |
| Move/journal failure         | Preserve both known paths, leave the durable journal, block new persistent fanout for that parent until recovery succeeds, and surface the transaction ID and paths.                                                                                |
| Archive read failure         | Report archive corruption or unreadability through the existing reader error surface. Do not silently return an empty history/artifact.                                                                                                             |
| Process crash                | Recover before the next fanout or archive-backed read. Finalize or roll back only from journal evidence.                                                                                                                                            |

## Test strategy

Add focused tests when implementing. Tests must create synthetic parent artifact directories and inject filesystem/device/free-space adapters. They must not depend on host disk pressure.

1. **Classification and accounting**
   - Verify only tombstoned `aborted` children become candidates.
   - Verify `running`, `idle`, `parked`, pending-revival, advisor, parent, backup, malformed, and Vibe-rehydratable children remain active.
   - Verify completed spill ownership, unknown logs, mixed parent/child artifact IDs, archive byte accounting, deterministic oldest-first order, and archive-limit behavior.

2. **Preflight**
   - Verify physical shortfall, archive-capacity, strict-active-limit, cross-device, and unrecoverable-transaction errors include the documented values and remedy.
   - Verify a failed preflight performs no child-ID allocation, artifact `mkdir`, temporary-directory creation, async job registration, child JSONL creation, or child process launch.
   - Verify reservations compose across concurrent fanout requests and release on cancellation, scheduling failure, and settlement.

3. **Atomicity and recovery**
   - Inject failures before the journal, after each rename, before manifest publication, and during rollback.
   - Verify no copy/delete fallback is attempted on `EXDEV`.
   - Simulate restart recovery for committed, staged-complete, partial, collision, and missing-file transactions.
   - Verify append-vs-archive, revive-vs-archive, lifecycle-transition-vs-archive, and spill-writer-vs-archive races using barriers. The active/revivable side must win every race.

4. **Reader compatibility**
   - Verify active and archived `history://`, `agent://`, Agent Hub incremental transcript reads, compact `<id>.md`, and `artifact://` resolve the same content and IDs.
   - Verify archived children are read-only, are not rediscovered as `parked`, and cannot be revived by task, hub, or Vibe.
   - Verify session relocation still resolves archive-relative paths.

5. **Stress**
   - Run high-fanout cases at and above `task.maxConcurrency`, with mixed synchronous/async tasks, repeated IDs, nested children, large spilled logs, concurrent reader requests, and terminal transitions.
   - Assert bounded archive accounting, no duplicate IDs, no lost transcript entries, no dangling manifests, no cross-device fallback, and no temporary artifacts after preflight rejection.

## Implementation touchpoints

Primary changes belong near these existing seams:

- `src/task/index.ts`: outer task fanout preflight before allocation and async registration.
- `src/task/structured-subagent.ts`: move persistent artifact leasing behind the reservation gate while preserving policy validation before any lease.
- `src/vibe/runtime.ts`: preflight Vibe fanout and block Vibe rehydration of archived terminal children.
- `src/registry/agent-lifecycle.ts` and `src/registry/persisted-agents.ts`: terminal sealing and archive-aware persisted discovery.
- `src/session/artifacts.ts`, session/history URL resolution, and Agent Hub transcript reads: archive-aware lookup with stable public identifiers.
- `src/cli/gc-cli.ts` and session listing: exclude `.fanout-archive/` from active session and GC traversal without changing the existing GC archive format.
- `src/config/settings-schema.ts` and `docs/settings.md`: configuration schema and user-facing settings documentation.

The implementation must not alter the parent session format, child JSONL payload format, compact summary format, or the existing GC archive format.

## Open decisions

None block implementation. The defaults above are conservative and explicit. If operational data later shows that 64 MiB per child is too high for common workloads, tune `task.fanoutArchive.reserveBytesPerChild` with measured fanout traces rather than weakening the free-space invariant.
