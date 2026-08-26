# Fanout resilience Task 1 report

## RED

Command:

```sh
bun test packages/coding-agent/test/session/fanout-archive.test.ts -t "normalizes fanout archive settings"
```

Output:

```text
error: command not found: bun
```

Exit status: 127.

The test file was created before production implementation, but the requested RED compilation result could not run because Bun is unavailable in this worktree environment.

## GREEN

Command:

```sh
bun test packages/coding-agent/test/session/fanout-archive.test.ts -t "normalizes fanout archive settings"
```

Output:

```text
error: command not found: bun
```

Exit status: 127.

No alternate test command or broader validation was run.

## Changed files

- `packages/coding-agent/src/session/fanout-archive.ts`
- `packages/coding-agent/src/session/session-manager.ts`
- `packages/coding-agent/src/tools/index.ts`
- `packages/coding-agent/src/sdk.ts`
- `packages/coding-agent/src/config/settings-schema.ts`
- `packages/coding-agent/test/session/fanout-archive.test.ts`

## Self-review

- Added all five `task.fanoutArchive.*` schema settings with the approved defaults and logical-versus-physical retention descriptions.
- `fanoutArchiveSettings()` rejects non-finite, non-integer, and negative byte values in favor of defaults.
- `SessionManager` memoizes one archive manager for its current artifact directory and clears it on session reset, restore, session-file change, fork, relocation, absent persisted session, and artifact-manager adoption.
- `ToolSession` exposes the manager through the SDK bridge.
- The new archive manager defines the approved typed surfaces and a zero-accounting snapshot; archival, recovery, and move semantics remain outside Task 1.

## Concern

Bun is not present on `PATH`; `which bun` produced no result, and no repository or common-user Bun wrapper was present. The required RED/GREEN test remains unverified until Bun is available.

## Verification update

The pinned executable supplied by the parent agent was used after the initial PATH failure:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun install --frozen-lockfile
```

The first setup attempt failed because its `prepare` script could not find `bun`; rerunning the same locked install with that pinned directory on `PATH` completed successfully. It generated the existing tool-views output and reported `Checked 422 installs across 553 packages (no changes)`.

Focused GREEN command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/session/fanout-archive.test.ts -t "normalizes fanout archive settings"
```

Output:

```text
error: Failed to load pi_natives native addon for darwin-arm64.
Tried:
- packages/natives/native/pi_natives.darwin-arm64.node: Cannot find module
- /Users/eric/.cache/omp-bun/node_modules/bun/bin/pi_natives.darwin-arm64.node: Cannot find module
```

Exit status: 1. The test process did not execute the test body.

Native setup approved by the parent agent:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun run build:native
```

Output:

```text
$ bun --cwd=packages/natives run build
$ bun ../../scripts/bazel-natives.ts host --dest native
Neither `bazelisk` nor `bazel` found on PATH.
error: script "build:native" exited with code 1
```

Exit status: 1. The missing Bazel/Bazelisk executable prevents the required native addon build, so the focused test cannot be rerun meaningfully.

## Updated concern

The locked workspace dependencies are installed, but the required local `pi_natives.darwin-arm64.node` addon is absent. Bazel is available, but its dependency registry request timed out; no broader build, test, lint, or workaround was run.

## Native build retry

With the supplied Bazelisk executable on `PATH`, the approved native setup was retried:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun run build:native
```

Output:

```text
$ bazelisk build -- //:natives-darwin-arm64
ERROR: Error computing the main repository mapping: Error accessing registry https://bcr.bazel.build/: Failed to fetch registry file https://bcr.bazel.build/modules/platforms/1.1.0/MODULE.bazel: Connect timed out
bazel build failed (exit 32)
error: script "build:native" exited with code 32
```

The Bazel executable was found and downloaded its pinned Bazel release, but the dependency registry request timed out. The native addon remains unavailable; therefore the focused test cannot execute.

## Native build second retry

The next approved retry used the same command and cached PATH:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun run build:native
```

Output:

```text
$ bazelisk build -- //:natives-darwin-arm64
ERROR: Error computing the main repository mapping: Error accessing registry https://bcr.bazel.build/: Failed to fetch registry file https://bcr.bazel.build/modules/rules_cc/0.2.17/MODULE.bazel: Connect timed out
bazel build failed (exit 32)
error: script "build:native" exited with code 32
```

The exact failed registry URL was `https://bcr.bazel.build/modules/rules_cc/0.2.17/MODULE.bazel`.

## Native build retry sequence

Two additional approved retries used the same command. Both exited 32 while fetching:

```text
https://bcr.bazel.build/modules/buildozer/8.5.1/MODULE.bazel
```

The first failed with `Connect timed out`; the second consecutively failed with the identical URL and error. Per the retry instruction, no further native-build attempts were made.

## Prebuilt native setup

The official matching prebuilt addon was copied as the ignored worktree build artifact:

```sh
cp /Users/eric/.cache/omp-native/node_modules/@oh-my-pi/pi-natives-darwin-arm64/pi_natives.darwin-arm64.node packages/natives/native/pi_natives.darwin-arm64.node
git check-ignore -q packages/natives/native/pi_natives.darwin-arm64.node
```

Output:

```text
ignored
```

This preserves the workspace loader path without changing tracked source.

## Final GREEN

Command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/session/fanout-archive.test.ts -t "normalizes fanout archive settings"
```

Output:

```text
bun test v1.3.14 (0d9b296a)

1 pass
0 fail
2 expect() calls
Ran 1 test across 1 file. [2.79s]
```

Exit status: 0.

## Final concern

The original plain `bun` command could not run because Bun was absent from `PATH`; the cached Bun executable was used for final verification. The supplied prebuilt addon is ignored, so it does not alter tracked source. No broader test, build, lint, formatter, commit, or source workaround was run.

## Adopted-manager ownership fix

Review identified that a child adopting its parent `ArtifactManager` created a separate `FanoutArchiveManager`, splitting ownership despite resolving the same parent artifact directory.

RED command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/session/fanout-archive.test.ts -t "shares the parent manager"
```

Output:

```text
0 pass
1 fail
error: expect(received).toBe(expected)
Expected: FanoutArchiveManager
Received: serializes to the same string
```

Exit status: 1.

`FanoutArchiveManager.forParent()` now owns a process-local manager map keyed by parent artifact directory. Parent and adopted child session managers therefore retrieve the same manager, while each session manager still clears its local reference on reset or relocation.

GREEN command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/session/fanout-archive.test.ts
```

Output:

```text
bun test v1.3.14 (0d9b296a)

2 pass
0 fail
3 expect() calls
Ran 2 tests across 1 file. [192.00ms]
```

Exit status: 0.
