# Task 9 report

## Scope

Modified Task 9 test files:

- `packages/coding-agent/test/session/fanout-archive.test.ts`
- `packages/coding-agent/test/task/fanout-preflight.test.ts`
- `packages/coding-agent/test/vibe/fanout-archive.test.ts`
- `packages/coding-agent/test/internal-urls/fanout-archive-reader.test.ts`

Confirmed production defects required source fixes in:

- `packages/coding-agent/src/session/fanout-archive.ts`

No other production files were changed.

## Deterministic RED evidence

All commands used `/Users/eric/.cache/omp-bun/node_modules/.bin/bun` because `bun` is not on `PATH` in this worktree.

1. `... bun test packages/coding-agent/test/session/fanout-archive.test.ts -t "keeps active or revivable children authoritative"`
   - Failed: after the `before-first-rename` barrier marked `Revived` idle and Vibe-revivable, `Revived.jsonl` was absent from active files. The archive had moved it.
2. `... bun test packages/coding-agent/test/session/fanout-archive.test.ts -t "admits 24 production children"`
   - Failed at `FanoutArchiveManager.preflight()` with `Fanout archive preflight is not available before archival accounting is configured`.
3. `... bun test packages/coding-agent/test/session/fanout-archive.test.ts -t "archives an ordinary production child"`
   - Failed with `ENOENT` for `.fanout-archive/entries/Dead/Dead.jsonl`: production `forParent()` had no filesystem/liveness dependencies, so no ordinary terminal child was eligible.

## Source fixes

- Production archive managers now receive the Node filesystem adapter and ordinary `AgentRegistry` liveness lookup.
- `preflight()` now performs a serialized physical-headroom/accounting check, reserves all requested children atomically, repeats the physical check at `claimChild()`, and releases reservation bytes exactly once on release, settlement, or cancellation.
- Publication rechecks liveness, Vibe revivability, transcript identity, tombstone identity, and spill identity after the journal barrier but before the first data rename. A failed recheck removes only the journal, leaves all child data active, and does not inflate archive accounting.

## Coverage added

- 65-child archive run with two concurrent archive requests and 24 concurrent transcript readers. The barrier changes the first child to idle/revivable before its first rename. The test verifies byte-for-byte active preservation, no archived revived child, unique publication IDs, and no copy/delete fallback.
- Transcript-writer and spill-writer barriers after journal publication, proving active writer data remains active and is not published.
- A real production `forParent()` 24-child reservation/settlement test, strict active-terminal/archive budget rejection test, and ordinary production terminal-child archive test.
- 25 persistent task children held behind deterministic gates at `task.maxConcurrency = 24`; the 25th starts only after a permit is released, with 25 claims and exactly 25 settlements.
- 24 rejected Vibe spawns, verifying each rejects before output allocation or job registration.
- 24 concurrent `history://Dead` reads with both an active and archived transcript, verifying the active transcript path and bytes win.
- Existing Task 1-8 recovery cases exercise committed, complete staged, partial, collision, mismatched, and unhealthy-journal states; Task 9 adds an explicit missing-staged-file recovery case.

## GREEN evidence

- `... bun test packages/coding-agent/test/session/fanout-archive.test.ts -t "admits 24 production children"` — 1 pass, 0 fail.
- `... bun test packages/coding-agent/test/session/fanout-archive.test.ts -t "keeps active or revivable children authoritative"` — 1 pass, 0 fail.
- `... bun test packages/coding-agent/test/session/fanout-archive.test.ts -t "keeps the active.*writer authoritative"` — 2 pass, 0 fail.
- `... bun test packages/coding-agent/test/session/fanout-archive.test.ts -t "archives an ordinary production child"` — 1 pass, 0 fail.
- `... bun test packages/coding-agent/test/session/fanout-archive.test.ts -t "rejects 24-child preflight"` — 1 pass, 0 fail.
- `... bun test packages/coding-agent/test/session/fanout-archive.test.ts -t "unrecoverable missing staged file"` — 1 pass, 0 fail.
- `... bun test packages/coding-agent/test/task/fanout-preflight.test.ts -t "bounds 25 persistent children"` — 1 pass, 0 fail.
- `... bun test packages/coding-agent/test/vibe/fanout-archive.test.ts -t "rejects 24 Vibe spawns"` — 1 pass, 0 fail.
- `... bun test packages/coding-agent/test/internal-urls/fanout-archive-reader.test.ts -t "keeps the active transcript authoritative"` — 1 pass, 0 fail.
- Task 9 stress command:

  ```bash
  /Users/eric/.cache/omp-bun/node_modules/.bin/bun test \
    packages/coding-agent/test/session/fanout-archive.test.ts \
    packages/coding-agent/test/task/fanout-preflight.test.ts \
    packages/coding-agent/test/vibe/fanout-archive.test.ts \
    packages/coding-agent/test/internal-urls/fanout-archive-reader.test.ts
  ```

  Result: 47 pass, 0 fail, 240 assertions.

## Limitations

Per Task 9 scope, formatter, lint, build/type check, heavy/full suite, commit, and push were not run. The plan's final cross-family review and final verification block remain for the parent workflow.
