# Task 8: Ordinary terminal archive sealing

## RED

The plan command using bare `bun` could not start because `bun` is not on `PATH`:

```sh
bun test packages/coding-agent/test/registry/agent-lifecycle.test.ts -t "schedules archive work only after a successful tombstone write"
```

```text
error: command not found: bun
```

Using the repository's cached Bun 1.3.14 runtime, removing the scheduler hook produced the focused terminal-seal RED:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/registry/agent-lifecycle.test.ts -t "schedules archive work only after a successful tombstone write"
```

```text
0 pass
24 filtered out
1 fail
Expected number of calls: 1
Received number of calls: 0
Ran 1 test across 1 file. [799.00ms]
```

The production owner-wiring test failed before its implementation because both executor options carried no archive scheduler:

```text
Expected: [archiveA, archiveB]
Received: [undefined, undefined]
```

The nested-parent regression then showed that using a parent session's shared archive manager misses direct children stored under the leased child artifacts directory:

```text
Expected FanoutArchiveManager.forParent(lease.artifactsDir) to have been called.
But it was not called.
```

The disposal gate test failed before the release ordering changed because a rejected dispose was swallowed:

```text
Expected promise that rejects
Received promise that resolved
```

The restored-child test failed before persisted discovery associated the child with its original parent manager:

```text
Expected FanoutArchiveManager.forParent(childParentDir) to have been called.
But it was not called.
```

## Implementation

- A terminal release temporarily guards the ref as `aborted` without emitting while live session disposal runs, preventing wrapped disposal from unregistering it. A failed dispose restores the previous status and leaves the session attached for retry. After successful disposal, release detaches the session, emits the terminal `aborted` state, writes `<child>.jsonl.tombstone`, then schedules archive eligibility; observers therefore never receive an `aborted` row with a live session. Tombstone-write errors likewise propagate and never schedule archival.
- Each persistent structured child uses `FanoutArchiveManager.forParent(lease.artifactsDir)`, the actual directory that will contain its direct child transcripts, rather than a shared parent `ArtifactManager` directory. The executor passes that exact scheduler through immediate hard-abort release and kept-alive lifecycle adoption.
- `AdoptedAgent` retains its scheduler by `AgentRef` for later hub or collaboration terminal releases. Persisted discovery also associates each restored ref with `FanoutArchiveManager.forParent(dirname(ref.sessionFile))`; cold adoption and a later terminal callback therefore use the transcript's original parent directory, not a mutable global/current parent. Vibe does not receive this wiring.
- Scheduler calls are idempotent per terminal ref. Ordinary releases and terminal refs without a persistent session file bypass scheduling.
- Existing persisted discovery prunes `.fanout-archive` and does not overwrite an existing `aborted` ref. The Task 1 schema already contains all five settings; this task adds their operational documentation.

## GREEN

Plan-required focused command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/registry/agent-lifecycle.test.ts packages/coding-agent/test/session/fanout-archive.test.ts -t "schedules archive work only after a successful tombstone write"
```

```text
1 pass
40 filtered out
0 fail
8 expect() calls
Ran 1 test across 2 files. [574.00ms]
```

Task8 regression command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/task/structured-subagent.test.ts packages/coding-agent/test/registry/agent-lifecycle.test.ts packages/coding-agent/test/session/fanout-archive.test.ts -t "schedules archive work only after a successful tombstone write|retains each adopted child's own archive scheduler|does not seal or schedule a terminal child until its session disposal succeeds|retains a restored child's original parent archive scheduler|passes each persistent parent's archive manager"
```

```text
5 pass
65 filtered out
0 fail
22 expect() calls
Ran 5 tests across 3 files. [612.00ms]
```

## Files

- `packages/coding-agent/src/registry/agent-lifecycle.ts`
- `packages/coding-agent/src/registry/persisted-agents.ts`
- `packages/coding-agent/src/task/executor.ts`
- `packages/coding-agent/src/task/structured-subagent.ts`
- `packages/coding-agent/test/registry/agent-lifecycle.test.ts`
- `packages/coding-agent/test/task/structured-subagent.test.ts`
- `docs/settings.md`
- `.superpowers/sdd/fanout-resilience/task-8-report.md`

## Limitations

Only focused tests ran. No formatter, linter, build, full suite, commit, push, or Task 9+ changes were performed. The requested bare `bun` command remains unavailable on `PATH`; the cached project runtime was used for verification.
