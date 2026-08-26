# Task 7: Vibe fanout archive lifecycle

## RED

Plan-required command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/vibe/fanout-archive.test.ts -t "preflights Vibe before ID/job creation"
```

Output before implementation:

```text
0 pass
1 fail
Expected archive.preflight to be called, but it was not called.
Ran 1 test across 1 file. [712.00ms]
```

Additional reservation-accounting RED:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/vibe/fanout-archive.test.ts -t "releases Vibe's unclaimed reservation"
```

Output before implementation:

```text
0 pass
1 filtered out
1 fail
Expected releasedChildren to be 1; received 0.
Ran 1 test across 1 file. [1005.00ms]
```

### Review-remediation RED

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/vibe/fanout-archive.test.ts -t "preflights Vibe before ID/job creation"
```

```text
0 pass
1 filtered out
1 fail
TypeError: undefined is not an object (evaluating 'spawn.id')
```

The terminal-rehydrate loop passed a missing spawn event into archive resolution. A second focused regression,
`-t "settles a claimed Vibe reservation once"`, failed because cancellation released an in-flight claim and still launched the subprocess.

## Implementation

- Vibe preflights a persistent spawn once, after worker policy resolution and before output-ID allocation, lifecycle persistence, async-job registration, or child-path creation.
- The opaque reservation stays on the Vibe record until first-turn startup claims it immediately before the persistent artifact directory is created. Cancellation waits for an in-flight claim, rechecks its signal before `mkdir`, and settles a completed claim or releases an unstarted one exactly once.
- A Vibe terminal record writes the child tombstone sidecar only after the durable parent tombstone event and after every teardown task settles, then retains the child as an aborted registry ref and schedules archive work. Terminal recovery follows the same seal ordering.
- Vibe rehydration checks the archive manager first; missing spawn records and terminal or zero-turn candidates are never restore candidates, and published transcripts are never re-registered as parked.
- `persistAgentTombstone` is shared with Vibe so the sidecar protocol remains identical to the lifecycle manager's existing terminal protocol.

## GREEN

Focused Vibe lifecycle command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/vibe/fanout-archive.test.ts
```

Output:

```text
3 pass
0 fail
20 expect() calls
Ran 3 tests across 1 file. [479.00ms]
```

Plan-required focused command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/vibe/fanout-archive.test.ts packages/coding-agent/test/registry/agent-lifecycle.test.ts
```

Output:

```text
27 pass
0 fail
141 expect() calls
Ran 27 tests across 2 files. [487.00ms]
```

The Vibe tests verify preflight occurs before output-ID allocation, the claim/settle and pre-scheduling release paths are exactly-once, cancellation cannot create persistent state after an in-flight claim, archival is scheduled only after the child sidecar exists, and active or published terminal children are not rehydrated.

## Files

- `packages/coding-agent/src/vibe/runtime.ts`
- `packages/coding-agent/src/registry/agent-lifecycle.ts`
- `packages/coding-agent/test/vibe/fanout-archive.test.ts`
- `.superpowers/sdd/fanout-resilience/task-7-report.md`

## Limitations

Only Task 7 focused tests ran. No formatter, linter, build, full suite, commit, push, or Task 8+ change was performed.
