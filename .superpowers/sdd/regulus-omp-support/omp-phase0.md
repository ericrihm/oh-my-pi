# OMP Regulus support: Phase 0

Recorded at `2026-08-10T16:06:51Z`. This report covers only `/Users/eric/dev/oh-my-pi-fanout-resilience` and its clean linked worktree. No implementation or model/provider command was run.

## Isolation and provenance

| Item | Observed value |
|---|---|
| Base checkout | `/Users/eric/dev/oh-my-pi-fanout-resilience` |
| Worktree | `/Users/eric/dev/oh-my-pi-regulus-omp-support` |
| Base branch | `feature/fanout-resilience` |
| Worktree branch | `feature/regulus-omp-support` |
| Base SHA | `45e12e5bb758198a920c6070e7e64cb33b21beac` |
| Commit | `45e12e5bb test(mnemopi): awaited detached shared-bank flush in lock-wait test` |
| Commit date | `2026-08-09T03:39:03+02:00` |

```text
$ git worktree add /Users/eric/dev/oh-my-pi-regulus-omp-support -b feature/regulus-omp-support 45e12e5bb758198a920c6070e7e64cb33b21beac
exit 0
HEAD is now at 45e12e5bb test(mnemopi): awaited detached shared-bank flush in lock-wait test
Preparing worktree (new branch 'feature/regulus-omp-support')

$ git rev-parse --show-toplevel
exit 0
/Users/eric/dev/oh-my-pi-regulus-omp-support

$ git rev-parse --git-dir
exit 0
/Users/eric/dev/oh-my-pi-fanout-resilience/.git/worktrees/oh-my-pi-regulus-omp-support

$ git rev-parse --git-common-dir
exit 0
/Users/eric/dev/oh-my-pi-fanout-resilience/.git

$ git rev-parse --show-superproject-working-tree
exit 0
<empty>

$ git branch --show-current
exit 0
feature/regulus-omp-support

$ git rev-parse HEAD
exit 0
45e12e5bb758198a920c6070e7e64cb33b21beac

$ git status --short
exit 0
<empty before this report was created>
```

`git worktree list --porcelain` returned both checkouts at the same SHA with distinct branches:

```text
worktree /Users/eric/dev/oh-my-pi-fanout-resilience
HEAD 45e12e5bb758198a920c6070e7e64cb33b21beac
branch refs/heads/feature/fanout-resilience

worktree /Users/eric/dev/oh-my-pi-regulus-omp-support
HEAD 45e12e5bb758198a920c6070e7e64cb33b21beac
branch refs/heads/feature/regulus-omp-support
```

The base checkout was dirty. These entries are evidence only and were not copied, staged, deleted, or modified:

```text
$ git -C /Users/eric/dev/oh-my-pi-fanout-resilience status --short
exit 0
 M packages/coding-agent/src/cli/gc-cli.ts
 M packages/coding-agent/src/config/settings-schema.ts
 M packages/coding-agent/src/internal-urls/artifact-protocol.ts
 M packages/coding-agent/src/internal-urls/history-protocol.ts
 M packages/coding-agent/src/internal-urls/registry-helpers.ts
 M packages/coding-agent/src/registry/persisted-agents.ts
 M packages/coding-agent/src/sdk.ts
 M packages/coding-agent/src/session/artifacts.ts
 M packages/coding-agent/src/session/session-manager.ts
 M packages/coding-agent/src/task/index.ts
 M packages/coding-agent/src/task/structured-subagent.ts
 M packages/coding-agent/src/tools/index.ts
 M packages/coding-agent/test/gc-cli.test.ts
 M packages/coding-agent/test/task/structured-subagent.test.ts
?? .superpowers/
?? docs/superpowers/
?? packages/coding-agent/src/session/fanout-archive.ts
?? packages/coding-agent/test/internal-urls/fanout-archive-reader.test.ts
?? packages/coding-agent/test/session/fanout-archive.test.ts
?? packages/coding-agent/test/task/fanout-preflight.test.ts
```

## Package, setup, and baseline

| Source | Value |
|---|---|
| Root package | `omp`, private ESM workspace |
| Root package manager | `bun@1.3.14` |
| Coding-agent package | `@oh-my-pi/pi-coding-agent@17.2.12` |
| Coding-agent engine | `bun >=1.3.14` |
| CLI bin | `omp -> packages/coding-agent/src/cli.ts` |
| Node | `v22.23.2` |
| Bun | `1.3.14` at `/Users/eric/.cache/omp-bun/node_modules/.bin/bun`; not on `PATH` |

Repository scripts observed in `package.json`:

```text
root setup: bun install && bun run build:native && bun --cwd=packages/coding-agent link && sh scripts/link-omp.sh
root test: bun scripts/ci-test-ts.ts local
coding-agent check: biome check . && bun run check:types
coding-agent check:types: tsgo -p tsconfig.json --noEmit
coding-agent test: bun ../../scripts/ci-test-ts.ts coding-agent-heavy --full
```

The full root setup script was not run because it performs native builds and link operations in addition to dependency installation. Bun discovery checked the requested standard locations and version managers before using an existing cached executable:

```text
$ which bun
exit 1
<empty>

$ which brew
exit 0
/opt/homebrew/bin/brew

$ brew list --versions bun
exit 1
<empty>

$ which mise
exit 1
<empty>

$ which asdf
exit 1
<empty>

Missing paths:
  $HOME/.bun/bin/bun
  /opt/homebrew/bin/bun
  /opt/homebrew/opt/bun/bin/bun
  /usr/local/bin/bun
  $HOME/.local/bin/bun
  $HOME/.local/share/mise/installs/bun/**/bin/bun
  $HOME/.asdf/installs/bun/**/bin/bun
  $HOME/.asdf/shims/bun

Repository pins:
  package.json#packageManager = bun@1.3.14
  packages/coding-agent/package.json#engines.bun = >=1.3.14
  no .tool-versions, .mise.toml, mise.toml, or .bun-version
```

The OMP runtime had an existing user-cache executable. The temporary OMP Bun shim resolved to `/Users/eric/.cache/omp-bun/node_modules/.bin/bun`; its cache package declares `bun: ^1.3.14`.

```text
$ /Users/eric/.cache/omp-bun/node_modules/.bin/bun --version
exit 0
1.3.14
```

No Bun installation was performed. The repository's documented bootstrap at `scripts/install.sh:155-166` pipes the unpinned network response from `https://bun.sh/install` into a shell and installs under `$HOME/.bun`; it was not run.

Dependency-only setup used the existing executable, a process-local `PATH`, the committed lockfile, and offline mode:

```text
$ PATH=/Users/eric/.cache/omp-bun/node_modules/.bin:$PATH /Users/eric/.cache/omp-bun/node_modules/.bin/bun install --frozen-lockfile --offline
exit 0
bun install v1.3.14 (0d9b296a)
Generated ../coding-agent/src/export/html/tool-views.generated.js (277.5 KiB)
394 packages installed [2.76s]
```

`git status --short` after setup still listed only the requested untracked `.superpowers/` report tree. The generated tool-view output matched committed content.

Bazel discovery found no executable on `PATH` or in the standard fixed locations:

```text
Missing paths:
  /opt/homebrew/bin/bazelisk
  /opt/homebrew/bin/bazel
  /usr/local/bin/bazelisk
  /usr/local/bin/bazel
  $HOME/.local/bin/bazelisk
  $HOME/.local/bin/bazel
  $HOME/bin/bazelisk
  $HOME/bin/bazel
  $HOME/.bazel/bin/bazel
  $HOME/.bazelisk/bin/bazelisk
  $HOME/.cache/bazelisk/**/bin/bazel

Repository pin:
  .bazelversion = 9.2.0
```

```text
$ brew list --versions bazelisk
exit 1
<empty>

$ brew list --versions bazel
exit 1
<empty>

$ which mise
exit 1
<empty>

$ which asdf
exit 1
<empty>

No `bazelisk`/`bazel` executable was present in the existing OMP Bun cache, Bun package cache, or npm cache.
```

An existing Bazelisk download cache contained the exact pinned Bazel executable:

```text
$ /Users/eric/Library/Caches/bazelisk/downloads/sha256/dd466352a3e4d3581b8898740ee1ff208866ccbe25f8d367c5dcb950219587e6/bin/bazel --version
exit 0
bazel 9.2.0
```

No executable was copied and no global path/configuration was changed. The cached binary's directory and cached Bun directory were added only to the build process environment.

Native prerequisite and focused baseline rerun:

```text
$ PATH=/Users/eric/Library/Caches/bazelisk/downloads/sha256/dd466352a3e4d3581b8898740ee1ff208866ccbe25f8d367c5dcb950219587e6/bin:/Users/eric/.cache/omp-bun/node_modules/.bin:$PATH /Users/eric/.cache/omp-bun/node_modules/.bin/bun --cwd=packages/natives run build
exit 32
$ bazel build -- //:natives-darwin-arm64
Starting local Bazel server (9.2.0) and connecting to it...
ERROR: Error computing the main repository mapping:
Error accessing registry https://bcr.bazel.build/:
Failed to fetch registry file https://bcr.bazel.build/modules/hermetic_cc_toolchain/4.2.0/MODULE.bazel:
Connect timed out
error: script "build" exited with code 32

$ /Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/task/task-schema.test.ts packages/coding-agent/test/task/task-preflight.test.ts packages/coding-agent/test/task/task-batch.test.ts packages/coding-agent/test/task/task-spawn.test.ts packages/coding-agent/test/tools/task-async-fallback.test.ts
exit 1
bun test v1.3.14 (0d9b296a)
All five files stopped on an unhandled load error before their tests ran:
Failed to load pi_natives native addon for darwin-arm64.
Missing: packages/natives/native/pi_natives.darwin-arm64.node
Loader guidance: bun --cwd=packages/natives run build

$ /Users/eric/.cache/omp-bun/node_modules/.bin/bun --cwd=packages/coding-agent run check:types
exit 0
$ tsgo -p tsconfig.json --noEmit
```

The repository supports an installed-addon path without copying or linking artifacts into the worktree. `packages/natives/native/loader-state.js` treats user-set `PI_COMPILED` as compiled mode; `packages/natives/test/issue-823-repro.test.ts` explicitly tests that override. In compiled mode the loader probes `~/.omp/natives/<packageVersion>` and requires the version-specific Rust export before accepting an installed addon. The existing installed OMP cache contained exactly one matching artifact:

```text
$ /Users/eric/.local/bin/omp --version
exit 0
omp/17.2.12

$ file /Users/eric/.omp/natives/17.2.12/pi_natives.darwin-arm64.node
exit 0
/Users/eric/.omp/natives/17.2.12/pi_natives.darwin-arm64.node: Mach-O 64-bit dynamically linked shared library arm64

$ shasum -a 256 /Users/eric/.omp/natives/17.2.12/pi_natives.darwin-arm64.node
exit 0
49113a473a0b4fb6cab77083d14ee4d1aa7b5cf74c4cfa711d5fb49438e8af31  /Users/eric/.omp/natives/17.2.12/pi_natives.darwin-arm64.node

$ PI_COMPILED=1 /Users/eric/.cache/omp-bun/node_modules/.bin/bun -e 'const m=await import("./packages/natives/native/index.js"); console.log(JSON.stringify({sentinel:typeof m.__piNativesV17_2_12,exportCount:Object.keys(m).length}));'
exit 0
{"sentinel":"function","exportCount":74}
```

The successful import exercised the loader's non-workspace validation: `@oh-my-pi/pi-natives@17.2.12` requires `__piNativesV17_2_12`, so a different release is rejected. Bun and the addon both ran as macOS arm64. No artifact was copied or symlinked, and no source or global configuration was modified.

Focused baseline using only that supported override:

```text
$ PI_COMPILED=1 /Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/task/task-schema.test.ts packages/coding-agent/test/task/task-preflight.test.ts packages/coding-agent/test/task/task-batch.test.ts packages/coding-agent/test/task/task-spawn.test.ts packages/coding-agent/test/tools/task-async-fallback.test.ts
exit 0
bun test v1.3.14 (0d9b296a)
38 pass
0 fail
183 expect() calls
Ran 38 tests across 5 files. [1066.00ms]

$ PI_COMPILED=1 /Users/eric/.cache/omp-bun/node_modules/.bin/bun --cwd=packages/coding-agent run check:types
exit 0
$ tsgo -p tsconfig.json --noEmit
```

**Baseline status: PASS.** Dependency-only setup, the actual coding-agent `check:types`, and all 38 focused baseline tests passed. The worktree-local native build remains unavailable offline because Bazel's repository cache lacks `hermetic_cc_toolchain@4.2.0`, but the repository-supported `PI_COMPILED=1` loader path accepted the installed same-version, same-architecture OMP addon after its version sentinel check. The future `packages/coding-agent/test/extensibility/task-router.test.ts` does not exist at this SHA and was not treated as a baseline test.

Final isolation check:

```text
$ git diff --name-only
exit 0
<empty>

$ git status --short
exit 0
?? .superpowers/

$ git status --ignored --short packages/natives/native
exit 0
<empty>
```

The failed native build and installed-addon baseline created no tracked source change and no ignored native output. The installed addon remained at its original user-cache path; the requested report remains the worktree's only untracked entry.

## Named seam reconfirmation

### Task validation order

1. Arktype validates model calls before `TaskTool.execute`. `TaskTool` enables `lenientArgValidation` so its shape diagnostics survive the flat schema's unknown-key deletion behavior (`task/index.ts:555-566`).
2. `execute` repairs raw params, resolves the session default agent, and reads `task.batch` (`task/index.ts:680-685`).
3. It runs `validateShapeParams`, then `validateSpawnParams` (`task/index.ts:686-689`). Batch checks cover a nonempty item array, no top-level task, each item task, coarse effort, case-insensitive unique names, and nonempty shared context (`task/index.ts:225-265`).
4. It normalizes flat or batch input into spawn items and per-spawn params (`task/index.ts:691-693`; helpers `273-307`).
5. It resolves every effective subagent policy concurrently. Any failure rejects the invocation before an executor or job manager observes the batch (`task/index.ts:694-721`).
6. It chooses blocking/async execution only after all policy preflights succeed (`task/index.ts:722-740`). Sync fallback covers disabled async, a missing job manager, or all-blocking items (`task/index.ts:737-743`).
7. `resolveEffectiveSubagentPolicy` validates the effective output schema before resolving model policy (`task/structured-subagent.ts:270-294`). Model-source precedence is caller `request.model`, `task.agentModelOverrides[agent]`, agent frontmatter model, then the active/fallback session model through the shared resolver (`task/structured-subagent.ts:281-294`).

The model-facing task surface still exposes coarse `lo|med|hi` effort. `StructuredSubagentRequest` has internal `model?: string|string[]`, but no trusted task-router API or `reviewOfRouteId` field exists.

### Model, auth, retry, and prewalk fallback

Current order in `task/executor.ts`:

1. Expand configured patterns and inherit a role/default retry chain for one configured model (`2838-2842`; helper `198-220`).
2. Call `resolveModelOverrideWithAuthFallback` (`2843-2857`). Failed requested credentials may select the parent session model (`2864-2870`).
3. Install a task-specific retry fallback role from remaining candidates or the inherited chain (`2872-2885`; helper `222-260`). Auth fallback suppresses retry-chain installation (`229-231`).
4. Map coarse effort to the resolved model and clamp it through `task.maxEffort` (`2889-2911`).
5. Resolve optional prewalk after model selection. Missing auth skips prewalk; the same model and effort is a no-op (`2923-2955`).

These are the paths a future strict route must bypass or reject: parent auth fallback, runtime retry fallback, coarse effort mapping/clamping, and prewalk.

### Extension model API

Current `ctx.models` provides `list()`, `current()`, `resolve(spec)`, and opaque `family(model)` (`extensibility/extensions/model-api.ts:20-38`; `extensions/types.ts:395-413`). `pi.exec(command, args, options)` is argv-based (`extensions/types.ts:1295-1296`). The extension context exposes `cwd`, registry, current model, and `models` (`extensions/types.ts:415-437`).

The planned `resolveSelection`, exact effort/auth result, stable catalog `vendorId`, `registerTaskRouter`, `taskRouterApiVersion`, and `reviewOfRouteId` identifiers are absent.

### SDK and extension assembly

The current order confirms the deferred-router seam:

1. SDK constructs built-in tools, including `TaskTool.create`, at `sdk.ts:1817-1818`; the task factory is `tools/index.ts:433`.
2. SDK discovers and loads extensions at `sdk.ts:1968-2027`.
3. SDK constructs `ExtensionRunner` at `sdk.ts:2538-2555`.

`ConcreteExtensionAPI` registers handlers, tools, commands, shortcuts, flags, renderers, and providers. `createExtension` retains path/resolvedPath and registration maps (`extensions/loader.ts:146-225,313-324`). It has no owning-package settings authority or task router.

### Plugin settings and link manager

- Loader reads global runtime config and project overrides; project plugin entries shadow user entries (`plugins/loader.ts:47-69,161-216`). Enabled discovery is cached by cwd/home (`23-33,176-190`).
- Loader settings merge global then project values without source metadata or manifest defaults (`plugins/loader.ts:523-534`).
- `PluginManager` caches runtime config per instance (`plugins/manager.ts:120-153`) and reads project overrides separately (`155-163`).
- `getPluginSettings` merges global/project values without source metadata; `setPluginSetting` writes cached global runtime config (`plugins/manager.ts:839-861`).
- `link(localPath)` creates a mutable symlink and runtime entry (`plugins/manager.ts:717-777`).
- The CLI supports `install`, `uninstall`, `list`, `link`, `doctor`, `features`, and `config`, but no `unlink` (`cli/plugin-cli.ts:24-64`). Existing `uninstall` invokes Bun package removal before deleting runtime config/settings (`plugins/manager.ts:628-659`), so it is not a linked-only removal seam.

### Source and bin anchors

All OMP source anchors named by the plan exist:

```text
packages/coding-agent/src/extensibility/extensions/types.ts
packages/coding-agent/src/extensibility/extensions/model-api.ts
packages/coding-agent/src/extensibility/extensions/loader.ts
packages/coding-agent/src/extensibility/extensions/runner.ts
packages/coding-agent/src/extensibility/plugins/loader.ts
packages/coding-agent/src/extensibility/plugins/manager.ts
packages/coding-agent/src/sdk.ts
packages/coding-agent/src/tools/index.ts
packages/coding-agent/src/task/types.ts
packages/coding-agent/src/task/index.ts
packages/coding-agent/src/task/structured-subagent.ts
packages/coding-agent/src/task/executor.ts
packages/coding-agent/src/async/job-manager.ts
packages/coding-agent/src/cli/plugin-cli.ts
```

The executable anchor is `packages/coding-agent/package.json#bin`, `omp: src/cli.ts`. Existing baseline test anchors are present:

```text
packages/coding-agent/test/task/task-schema.test.ts
packages/coding-agent/test/task/task-preflight.test.ts
packages/coding-agent/test/task/task-batch.test.ts
packages/coding-agent/test/task/task-spawn.test.ts
packages/coding-agent/test/tools/task-async-fallback.test.ts
```

## Result

- Isolation: PASS.
- Dirty base capture without modification: PASS.
- Package/version and named seam reconfirmation: PASS.
- Dependency-only setup: PASS, existing Bun 1.3.14 cache, frozen lockfile, offline mode.
- Coding-agent `check:types`: PASS under the same supported loader environment.
- Worktree-local native build: BLOCKED offline, pinned Bazel 9.2.0 found but required BCR module absent from cache.
- Installed native compatibility: PASS, OMP/package 17.2.12, Mach-O arm64, required `__piNativesV17_2_12` sentinel loaded.
- Focused baseline tests: PASS, 38 tests across five files.
- Paid model calls: none.
- Implementation: not started.
