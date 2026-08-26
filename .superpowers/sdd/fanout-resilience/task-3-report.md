# Task 3: Journaled same-device archival

## Changed files

- `packages/coding-agent/src/session/fanout-archive.ts`
- `packages/coding-agent/test/session/fanout-archive.test.ts`
- `.superpowers/sdd/fanout-resilience/task-3-report.md`

## Implementation

- Serialized archival and recovery with a per-manager asynchronous mutex.
- Re-inspected terminal liveness and the inspection fence immediately before journaling.
- Verified source, parent archive, transaction, staging, and entries roots share one device before the first move.
- Added durable exclusive-write transaction journals, staging-only source renames, manifest publication, atomic staging-to-entry publication, and journal removal after successful publication.
- Added recovery for published transactions, complete staged transactions, and unambiguous partial staging rollback. Collision, missing, mismatched-file/device, invalid-journal, failed-finalization, and failed-rollback states remain intact and are surfaced through `snapshot().unhealthyTransaction`.
- Made `preflight()` reject with `FanoutStoragePreflightError("unsafe-recovery", ...)` when recovery is unhealthy. `EXDEV` is converted to exported `FanoutArchiveMoveError` and no copy, link, compression, or source-data-unlink fallback exists.

## RED evidence

Command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/session/fanout-archive.test.ts -t 'recovers.*without copy/delete fallback'
```

Output before implementation:

```text
0 pass
4 fail
Ran 4 tests across 1 file.
```

Each interruption case failed for the intended reason: the archive call resolved instead of rejecting because the journal protocol and failure barriers did not yet exist.

## GREEN evidence

Command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/session/fanout-archive.test.ts -t 'recovers.*without copy/delete fallback'
```

Output after implementation:

```text
4 pass
3 filtered out
0 fail
16 expect() calls
Ran 4 tests across 1 file.
```

The four verified interruption points are `before-first-rename`, `after-transcript-rename`, `after-spill-rename`, and `before-manifest`. Each restart leaves exactly one complete active or published representation and observes zero copy calls and zero source-data unlink calls.

## Self-review

- The journal records immutable file identity fields that survive a rename (`dev`, `ino`, `size`, `mtimeMs`). `ctimeMs` is intentionally not used for post-rename matching because a rename updates it on the target filesystem.
- Recovery never deletes staged, active, final, or ambiguous data. Its only deletion operation is `removeJournal()` after successful final publication or a completed unambiguous rollback.
- Archive entry detection in the existing fixture now records the final staging-directory rename rather than the former per-file rename.

## Concerns

- Focused Task 3 recovery coverage was intentionally the only validation run, per assignment. No broader suite, formatter, linter, build, later reader/GC work, or admission integration was run.
- The focused test uses the supplied filesystem seam and confirms the implementation never needs a copy or source-data-unlink operation; no fallback API was added to the production filesystem contract.

## Review follow-up

The Task 3 review findings were addressed test-first:

- Journal and manifest publication now use exclusive temporary writes, file sync, no-replace rename, and parent-directory sync. Entry-directory publication is synced and revalidated against the journal before journal removal.
- Rollback rechecks each destination after its barrier and uses the no-replace filesystem primitive; a recreated active source therefore remains intact and marks the transaction unhealthy.
- Each recovery pass clears its prior unhealthy snapshot before scanning every journal, then repopulates it only for transactions still unhealthy.
- Recovery tests now create a fresh manager instance, assert full transcript/tombstone/spill manifest completeness, and assert no remaining transaction journal for a resolved representation.

Focused review RED command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/session/fanout-archive.test.ts -t 'recovers.*without copy/delete fallback|durably publishes|preserves a journal|preserves a recreated'
```

RED output:

```text
0 pass
7 fail
Ran 7 tests across 1 file.
```

Focused review GREEN command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/session/fanout-archive.test.ts -t 'recovers.*without copy/delete fallback|durably publishes|preserves a journal|preserves a recreated'
```

GREEN output:

```text
7 pass
3 filtered out
0 fail
28 expect() calls
Ran 7 tests across 1 file.
```

## Final durability follow-up

Added crash-window RED tests for orphaned manifest temporaries, staged identity mutation before entry publication, and directory-sync ordering across archive creation and rollback. The protocol now uses UUID-named temporaries outside a staging directory being published, verifies every staged identity and source absence before entry rename (and again afterwards), syncs both directories after every forward/rollback rename, and syncs archive roots after creating their durable names.

Focused final RED command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/session/fanout-archive.test.ts -t 'orphaned manifest|staged file|syncs created'
```

```text
0 pass
3 fail
Ran 3 tests across 1 file.
```

Focused all-Task-3 GREEN command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/session/fanout-archive.test.ts -t 'recovers.*without copy/delete fallback|durably publishes|preserves a journal|preserves a recreated|orphaned manifest|staged file|syncs created'
```

```text
10 pass
3 filtered out
0 fail
34 expect() calls
Ran 10 tests across 1 file.
```
