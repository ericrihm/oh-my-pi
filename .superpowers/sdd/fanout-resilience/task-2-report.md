# Task 2 report

## Commands and results

- RED (before production implementation):
  ```text
  /Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/session/fanout-archive.test.ts -t "selects only stable tombstoned aborted children"
  ```
  Exit 1. Bun reported `0 pass`, `1 fail`, and `2 filtered out`; the expected published-child assertion failed because `archiveTerminalChildren()` was still a no-op and did not perform eligibility or accounting.

- GREEN:
  ```text
  /Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/session/fanout-archive.test.ts -t "selects only stable tombstoned aborted children"
  ```
  Exit 0. Bun reported `1 pass`, `0 fail`, and `2 filtered out`.

## Changed files

- `packages/coding-agent/src/session/fanout-archive.ts`
  - Adds terminal-child inspection using direct filenames, tombstone and matching aborted registry state, Vibe non-revivability, regular/unlinked source checks, JSONL parsing, spill ownership checks, destination checks, and a pre/post-read stat fence.
  - Sorts eligible candidates by tombstone timestamp, transcript mtime, then child ID.
  - Publishes capacity-fitting entries and updates logical archive, active-terminal, and reclaimable accounting.

- `packages/coding-agent/test/session/fanout-archive.test.ts`
  - Adds a focused native-filesystem fixture and one classification/accounting contract covering oldest-first selection, archive capacity, unknown spills, live/parked/Vibe children, malformed/changing/linked/symlinked/escaped inputs, duplicate or occupied destinations, and ambiguous spill ownership.

## Self-review

- Every candidate is constrained to its direct parent path and its registry `sessionFile` must resolve to that same transcript.
- The test observes actual transcript-rename order, so the oldest-first assertion is independent of directory enumeration order.
- Archive bytes are recorded only from valid published manifests; retained active-terminal bytes include only otherwise eligible candidates that did not fit the configured logical limit.
- Re-inspection immediately before publication rejects changed, revived, or newly occupied candidates.

## Concerns

- The entry publication here is intentionally the minimum fixture-visible move/manifest behavior for Task 2. It is not interruption-safe: Task 3 owns journaling, staging, same-device enforcement, recovery, and atomic publication.
- No formatter, linter, build, full suite, commit, or push was run, per scope.

## Review-finding remediation

- Added a parent-reference fixture: an aborted child with `session_init` text containing `artifact://30` and a parent-owned `30.bash.log`. Such a reference is now unresolved ownership, so both the transcript and spill remain active.
- Changed spill ownership recognition to successful `message.toolResult` records whose durable `details.meta.truncation.artifactId` identifies the owned completed spill. Bare references are never ownership evidence.
- Added a one-byte residual archive-capacity case. A candidate cannot be partially reclaimed: candidate selection stops at the first oldest entry that cannot fit, and `archiveReclaimableBytes` sums only whole oldest-first active candidates.
- RED after adding these assertions used the same focused command and exited 1 (`0 pass`, `1 fail`, `2 filtered`), before the ownership and atomic-accounting changes.
- GREEN after the fixes used the same focused command and exited 0 (`1 pass`, `0 fail`, `2 filtered`).
