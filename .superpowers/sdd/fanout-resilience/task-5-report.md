# Task 5: Outer fanout admission and reservation accounting

## RED

Command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/task/fanout-preflight.test.ts
```

Output before implementation:

```text
0 pass
5 fail
Ran 5 tests across 1 file.
```

Each failure expected the actionable `Fanout storage preflight rejected 24 children:` output but instead reached async job registration and returned `Failed to start background task jobs: unexpected: unexpected job registration; ...`. This demonstrated that policy resolution did not yet gate persistent fanout admission before output-ID allocation or job scheduling.

## Implementation

- After every item resolves policy successfully, `TaskTool` now invokes one persistent-parent archive `preflight()` before selecting sync/async execution, allocating output IDs, acquiring semaphores, registering jobs, or invoking children.
- The exact `FanoutStoragePreflightError.message` is returned unchanged. Non-persistent parents bypass archive admission.
- The one reservation returned by the outer preflight is propagated through all sync, mixed, and async child requests.
- Per-child idempotent accounting releases an unclaimed reservation on scheduling failure and cancellation before execution, and settles it once after a started child completes or fails.
- `packages/coding-agent/src/tools/index.ts` already exposed `ToolSession.getFanoutArchiveManager()` from Task 1, so it required no Task 5 change.

## GREEN

Command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/task/fanout-preflight.test.ts packages/coding-agent/test/task/task-preflight.test.ts
```

Output:

```text
bun test v1.3.14 (0d9b296a)

14 pass
0 fail
61 expect() calls
Ran 14 tests across 2 files. [788.00ms]
```

Focused coverage verifies actionable physical-space, cross-device, unsafe-recovery, strict active-terminal-budget, and archive-capacity refusals with no output-ID allocation, artifact-path creation, or async-job registration. It also verifies the non-persistent bypass and exact release/settle accounting for scheduling failure, synchronous completion, and queued async cancellation.

## Files

- `packages/coding-agent/src/task/index.ts`
- `packages/coding-agent/test/task/fanout-preflight.test.ts`
- `.superpowers/sdd/fanout-resilience/task-5-report.md`

## Lifecycle self-review and limitations

- Each reservation lifecycle wrapper sets its accounting flag before calling the archive manager, preventing duplicate release/settle calls across result, error, cancellation, and `finally` paths.
- A job that cancels before obtaining a semaphore releases its reservation; a job that starts settles it exactly once, including a failed child result.
- This task forwards the shared reservation through the child request. Task 6 remains responsible for the child-side final `claimChild()` gate before persistent artifact leasing and ID allocation; that file was intentionally not changed.
- No formatter, linter, build, full suite, commit, or push was run.

## Review-finding remediation

### RED

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/task/fanout-preflight.test.ts -t "fails closed|cancels the outer reservation"
```

```text
0 pass
2 fail
Ran 2 tests across 1 file. [879.00ms]
```

The persistent-null-manager case fell through to job registration, and a rejected output-ID allocation left the outer reservation's cancellation count at zero.

### GREEN

Focused review-fix command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/task/fanout-preflight.test.ts -t "fails closed|cancels the outer reservation"
```

```text
2 pass
9 filtered out
0 fail
6 expect() calls
Ran 2 tests across 1 file. [1434.00ms]
```

Final focused Task 5 command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/task/fanout-preflight.test.ts packages/coding-agent/test/task/task-preflight.test.ts
```

```text
16 pass
0 fail
67 expect() calls
Ran 16 tests across 2 files. [1370.00ms]
```

- A persistent parent without a non-null archive manager now fails closed before output-ID allocation or job registration.
- Any output-ID allocation failure cancels the shared outer reservation exactly once before the error propagates.
