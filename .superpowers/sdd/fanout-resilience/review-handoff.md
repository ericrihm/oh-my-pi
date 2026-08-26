# Fanout resilience Task 9 review handoff

## Scope and changed files

Task 9 test coverage:

- `packages/coding-agent/test/session/fanout-archive.test.ts`
- `packages/coding-agent/test/task/fanout-preflight.test.ts`
- `packages/coding-agent/test/vibe/fanout-archive.test.ts`
- `packages/coding-agent/test/internal-urls/fanout-archive-reader.test.ts`

Confirmed baseline defects fixed at source:

- `packages/coding-agent/src/session/fanout-archive.ts`

Task reports:

- `.superpowers/sdd/fanout-resilience/task-9-report.md`
- `.superpowers/sdd/fanout-resilience/review-handoff.md`

## Review focus

1. Can a live/revivable transcript or active spill move after the journal is durable but before the first rename?
   - Source now rechecks registry liveness, Vibe revivability, session-file identity, and every source identity after `before-first-rename`.
   - Barrier tests cover lifecycle/revival, transcript append, and spill append; active bytes remain unchanged.
2. Can `EXDEV` reach copy/delete fallback?
   - The implementation still routes `EXDEV` through `FanoutArchiveMoveError`; tests assert zero copy and data-unlink calls. No copy/delete API was added.
3. Can recovery lose or fabricate data?
   - Focused recovery covers interruption before any rename, partial transcript/spill movement, complete staged finalization, published corruption, collision, staged mismatch, and explicit missing staged data. The missing-file case leaves the journal unhealthy rather than fabricating a replacement.
4. Can manifests break active/archive readers?
   - Concurrent `history://` resolution with active plus archived `Dead` verifies the active transcript path wins. Existing archive reader tests cover relocation, compact summaries, archive artifact IDs, and corrupt manifests.
5. Can preflight create state before rejecting?
   - Existing task and new Vibe tests verify rejected 24-child fanout does not allocate output IDs or register jobs. New production manager tests verify real `forParent()` 24-child reservation accounting plus strict/archival budget rejection.

## Evidence

Bun was invoked explicitly because the worktree has no `bun` on `PATH`:

```bash
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test \
  packages/coding-agent/test/session/fanout-archive.test.ts \
  packages/coding-agent/test/task/fanout-preflight.test.ts \
  packages/coding-agent/test/vibe/fanout-archive.test.ts \
  packages/coding-agent/test/internal-urls/fanout-archive-reader.test.ts
```

Final focused run: `47` pass, `0` fail, `240` assertions.

Targeted RED/GREEN commands and their outputs are recorded in `task-9-report.md`.

## Remaining verification and risk

- Not run by Task 9: formatter, lint, type check, heavy/full suite, commit, or push.
- The plan's final verification block and cross-family review remain mandatory before integration.
- `productionDependencies().renameNoReplace` protects same-manager publication with a destination existence check, but Node does not expose a portable no-replace directory rename primitive. Review concurrent external-writer behavior explicitly.
