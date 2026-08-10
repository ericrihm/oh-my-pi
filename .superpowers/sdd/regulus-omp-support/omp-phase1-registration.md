# OMP Regulus support: Phase 1 registration

Recorded at `2026-08-10` in `/Users/eric/dev/oh-my-pi-regulus-omp-support`.

Commit range: `d99c8d437619f7e09dfd464d9530b242f4d575a4..78123c3e484137f8f845c13f232faa06dca9470a`

The range contains one commit:

```text
78123c3e4 feat(extensions): add task router SDK
```

Range size: 14 files changed, 430 insertions, 178 deletions.

## Changed files and symbols

### Production

- `packages/catalog/src/identity/family.ts`
  - Added `stableModelVendorId(modelId, provider)`, a catalog-owned persistent vendor identity distinct from the comparison-only `modelFamilyToken()`.
- `packages/coding-agent/src/extensibility/extensions/index.ts`
  - Exported `ExtensionRuntime` and the source-aware discovery API.
- `packages/coding-agent/src/extensibility/extensions/loader.ts`
  - Added `ConcreteExtensionAPI.registerTaskRouter()` with one-router ownership and API-version enforcement.
  - Made `createExtension()`, `bindExtension()`, and `loadExtensions()` carry `ExtensionSourceDescriptor` authority.
  - Added `validateManifestSettings()` and `describeExtensionSource()`.
  - Added `discoverExtensionSources()` and retained `discoverExtensionPaths()` as the path-only compatibility view.
  - Updated `discoverAndLoadExtensions()` to discover and load source descriptors.
- `packages/coding-agent/src/extensibility/extensions/model-api.ts`
  - Extended `createExtensionModelQuery()` with asynchronous `resolveSelection()` using core model resolution, live credential probing, exact thinking effort, and `stableModelVendorId()`.
- `packages/coding-agent/src/extensibility/extensions/types.ts`
  - Added `ExtensionResolvedModelSelection`, `ExtensionSourceDescriptor`, `ExtensionSettingsQuery`, task-router request/decision/registration types, and `RegisteredTaskRouter`.
  - Added `ExtensionAPI.registerTaskRouter`, `Extension.source`, optional `Extension.taskRouter`, and source/router fields on `LoadExtensionsResult`.
- `packages/coding-agent/src/extensibility/legacy-pi-coding-agent-shim.ts`
  - Updated legacy load-result construction and forwarding for required source descriptors.
- `packages/coding-agent/src/extensibility/plugins/types.ts`
  - Added `PluginManifest.taskRouterApiVersion`.
- `packages/coding-agent/src/sdk.ts`
  - Added `CreateAgentSessionOptions.preloadedExtensionSources` and `discoverSessionExtensionSources()`.
  - Preserved package descriptors while rebuilding session-scoped extension instances; retained path-only compatibility for deferred callers.

### Tests and fixtures

- `packages/coding-agent/test/extensibility/extension-source-authority.test.ts`
  - Added the within-extension exclusive-router registration assertion and aligned descriptor/session fixtures with the source-aware result contract.
- `packages/coding-agent/test/extensibility/task-router.test.ts`
- `packages/coding-agent/test/extensibility/task-router-phase2.test.ts`
  - Kept the pre-existing RED contracts type-compatible with the registered-router type names; TaskTool consumption remains intentionally RED.
- `packages/coding-agent/test/sdk-credential-disabled-bridge.test.ts`
- `packages/coding-agent/test/sdk-preloaded-extensions-isolation.test.ts`
- `packages/coding-agent/test/task/executor-launch-startup.test.ts`
  - Added required empty source descriptors or adopted the source-aware preload option in existing SDK fixtures.

## Behavior implemented

- A package extension can register exactly one task router through `registerTaskRouter({ id, apiVersion: 1, ... })`.
- Duplicate registration within one extension and competing routers across loaded extensions are rejected with both owners identified.
- Packaged routers must match the manifest's `taskRouterApiVersion`; unsupported versions are rejected.
- Extension discovery retains package root, name, version, manifest, load kind, and packaged-versus-standalone authority instead of flattening entries to strings.
- Manifest setting grammar and defaults are validated during source discovery. Standalone configured files do not receive inferred package authority.
- SDK session reconstruction accepts source descriptors and rebinds extension factories to the child session without discarding package authority.
- `ctx.models.resolveSelection()` waits for in-flight discovery, refreshes the selected provider with caller cancellation, re-resolves from the post-refresh registry snapshot, probes the credential store live, and returns canonical provider/model identity plus exact effort. Catalog-owned `stableModelVendorId()` maps canonical vendor IDs independently of comparison-only `family()` tokens and refuses unknown identity.
- Router invocation requests are deep-readonly in the public API and deep-frozen at runtime. The closed v1 per-item safe context is `routingContext: { sharedContext?: string }`; it carries only the existing model-authored shared task context, and Regulus must exclude it from classification.

This phase does not connect the registered router to TaskTool execution.

## Focused tests

Environment for every test below: `PI_COMPILED=1`. The commands use the repository's known Bun executable directly.

### Registration and model-selection GREEN scope

```text
$ PI_COMPILED=1 /Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/catalog/test/identity-family.test.ts
exit 0
29 pass
0 fail
161 expect() calls
Ran 29 tests across 1 file. [71.00ms]

$ PI_COMPILED=1 /Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/extensibility/ext-model-query.test.ts
exit 0
12 pass
0 fail
29 expect() calls
Ran 12 tests across 1 file. [196.00ms]

$ PI_COMPILED=1 /Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/extensibility/extension-source-authority.test.ts --test-name-pattern 'carries valid|refuses invalid|keeps standalone|exclusive router|deep-freezes'
exit 0
5 pass
3 filtered out
0 fail
16 expect() calls
Ran 5 tests across 1 file. [642.00ms]
```

The model-query tests cover compatibility plus post-refresh re-resolution, cancellation propagation, abort cleanup, live credential probes, and canonical vendor identity. Catalog identity tests pin exact vendor mappings and unknown-identity refusal. Source-authority tests cover packaged authority/defaults, invalid setting refusal, exclusive registration, standalone isolation, and complete request deep-freezing.

### Remaining source/session REDs

```text
$ PI_COMPILED=1 /Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/extensibility/extension-source-authority.test.ts
exit 1
5 pass
3 fail
21 expect() calls
Ran 8 tests across 1 file. [1131.00ms]
```

Expected deferred failures:

1. `preserves explicit package authority through a real nested subagent session rebuild`
2. `clears package authority when restricted nested execution resets extension isolation`
3. `checks linked enablement and settings freshly on every routed task`

These continue past loader registration into the deferred TaskTool/session forwarding and live plugin-state wiring.

### Remaining Phase 1 TaskTool REDs

```text
$ PI_COMPILED=1 /Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/extensibility/task-router.test.ts
exit 1
0 pass
12 fail
15 expect() calls
Ran 12 tests across 1 file. [952.00ms]
```

All 12 failures are expected because TaskTool does not yet receive or consume the registered router. They cover the one-shot SDK handoff; complete ordered decisions; atomic refusal of rejected, malformed, partial, overlong, and reversed decisions; competing/unsupported routers through full session startup; deadline and caller abort; and no-router/null compatibility.

### Quarantined Phase 2 REDs

```text
$ PI_COMPILED=1 /Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/extensibility/task-router-phase2.test.ts
exit 1
0 pass
10 fail
27 expect() calls
Ran 10 tests across 1 file. [928.00ms]
```

These expected REDs cover sealed strict-selection execution; exact effort, vendor, max-effort, and live-auth refusal; prewalk suppression; lifecycle ordering/failure containment; once-only settlement; writer receipts; trusted review framing; and full UTF-8 output capture before truncation.

## Package checks

### Coding agent

```text
$ cd /Users/eric/dev/oh-my-pi-regulus-omp-support/packages/coding-agent && PATH=/Users/eric/.cache/omp-bun/node_modules/.bin:$PATH PI_COMPILED=1 /Users/eric/.cache/omp-bun/node_modules/.bin/bun run check
exit 0
$ biome check . && bun run check:types
Checked 2578 files in 1633ms. No fixes applied.
$ tsgo -p tsconfig.json --noEmit
```

### Catalog

```text
$ cd /Users/eric/dev/oh-my-pi-regulus-omp-support/packages/catalog && PATH=/Users/eric/.cache/omp-bun/node_modules/.bin:$PATH PI_COMPILED=1 /Users/eric/.cache/omp-bun/node_modules/.bin/bun run check
exit 0
$ biome check . && bun run check:types
Checked 134 files in 76ms. No fixes applied.
$ tsgo -p tsconfig.json --noEmit
```

## No-paid evidence

No provider CLI, hosted inference command, or model invocation was run. The recorded commands are local `git`, `bun test`, Biome, and `tsgo` commands. The model-selection tests use fixture registries and mocked credential probes; the RED router tests mock executor/session boundaries. No test output reports a network request or provider execution.

## Deferred scope

- Connect the one-shot registered router reference through SDK assembly into TaskTool.
- Validate and atomically apply complete ordered batch decisions after public task validation and before allocation, auth lookup, async registration, or child execution.
- Enforce route timeout and caller-abort cleanup.
- Preserve/clear source descriptors through actual nested TaskTool session reconstruction and read linked enablement/settings freshly per route.
- Revalidate strict selections against live model/auth state, enforce exact effort/vendor/max-effort, disable prewalk and fallback behavior, and execute the sealed selector.
- Implement `onStarted`/`onSettled` lifecycle containment and once-only settlement.
- Capture full writer receipts before truncation and inject exact trusted review frames.
- Regulus adapter, plugin link/config/unlink surfaces, orchestration policy, provenance recorder, and end-to-end integration remain outside this registration commit.
