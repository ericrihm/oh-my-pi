# Task 6: Persistent child final reservation gate

## RED

Command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/task/structured-subagent.test.ts -t "does not lease artifacts or allocate a child ID|settles a claimed persistent child once"
```

Output:

```text
0 pass
2 fail
Ran 2 tests across 1 file. [31.42s]
```

Before implementation, the rejecting-reservation invocation resolved instead of rejecting after persistent artifact leasing; the claimed-child invocation recorded zero claims and zero settlements. The first test timed out because the pre-change persistent subprocess path remained active after it resolved.

### Review-remediation RED

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/task/structured-subagent.test.ts -t "cancellation follows policy resolution"
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/task/fanout-preflight.test.ts -t "defers async output ID allocation"
```

Both commands produced `0 pass`, `1 fail`: the first resolved after a cancellation raced policy resolution, and the second recorded one output-ID allocation before the rejecting final claim.

### Identity-rebinding RED

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/task/fanout-preflight.test.ts -t "binds repeated persistent async jobs"
```

Output: `0 pass`, `1 fail`. The second reused child was allocated as `Child-2`, but its queued job retained the old `Child` agent identity.

### Live-identity RED

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/task/fanout-preflight.test.ts -t "does not advertise a provisional ID"
```

Output: `0 pass`, `1 fail`. The initial async response offered the queued `pending-…` identifier as an agent ID and DM target while the child had only its later allocated registry ID.

### Rejected-child hint RED

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/task/fanout-preflight.test.ts -t "defers async output ID allocation"
```

Output: `0 pass`, `1 fail`. A final-claim rejection had no child result but the delivery appended an idle/history/DM hint for the provisional queued identifier.

## Implementation

- `StructuredSubagentRequest` now accepts an optional `FanoutArchiveReservation`.
- After policy resolution, a persistent child checks cancellation, then claims the forwarded reservation before artifact leasing or `reserveStructuredSubagentId()`.
- The structured-subagent `finally` releases an unclaimed reservation after every terminal pre-claim path, or settles a claimed reservation once after every terminal execution path. Temporary parents bypass reservation lifecycle calls.
- Persistent async and mixed fanouts now use unique provisional queued-job labels and defer irreversible output-ID allocation to structured execution after the final claim. Initial guidance identifies only the job until startup completes. The first live progress update binds job metadata, progress ID, follow-up hints, and mixed-result matching to the actual allocated child ID. Rejected child deliveries never attach idle, history, or DM guidance. The outer lifecycle still releases scheduling, semaphore-acquisition, and pre-dispatch failures; it no longer settles a child after dispatch returns.

## GREEN

Plan-required command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/task/structured-subagent.test.ts -t "does not lease artifacts or allocate a child ID"
```

Output:

```text
1 pass
27 filtered out
0 fail
4 expect() calls
Ran 1 test across 1 file. [565.00ms]
```

Additional focused lifecycle commands:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/task/structured-subagent.test.ts -t "does not lease artifacts or allocate a child ID|releases an unclaimed persistent reservation|cancellation follows policy resolution|settles a claimed persistent child once"
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/task/fanout-preflight.test.ts -t "settles a claimed child when deferred output-ID allocation fails|defers async output ID allocation|binds repeated persistent async jobs|does not advertise a provisional ID for coordination|claims each synchronous child and settles it exactly once"
```

Output:

```text
4 pass
24 filtered out
0 fail
10 expect() calls
Ran 4 tests across 1 file. [924.00ms]

5 pass
9 filtered out
0 fail
20 expect() calls
Ran 5 tests across 1 file. [695.00ms]
```

## Files

- `packages/coding-agent/src/task/structured-subagent.ts`
- `packages/coding-agent/src/task/index.ts`
- `packages/coding-agent/test/task/structured-subagent.test.ts`
- `packages/coding-agent/test/task/fanout-preflight.test.ts`
- `.superpowers/sdd/fanout-resilience/task-6-report.md`

## Limitations

Only Task 5/6 focused tests ran. No formatter, linter, build, full suite, commit, push, or Task 7+ work was performed.
