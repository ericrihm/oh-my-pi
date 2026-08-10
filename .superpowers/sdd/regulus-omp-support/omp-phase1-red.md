# OMP Regulus support: Phase 1 RED

Recorded at `2026-08-10`. Scope is only `/Users/eric/dev/oh-my-pi-regulus-omp-support` on branch `feature/regulus-omp-support`, based on `45e12e5bb758198a920c6070e7e64cb33b21beac`. No production code or paid model call was used.

## Frozen implementation decisions

- Add one exclusive, versioned task-router registration surface: `registerTaskRouter({ id, apiVersion: 1, route, onStarted?, onSettled? })`.
- Route only after public task validation. Deliver one immutable invocation request with the invocation `taskCwd` and an ordered `items` array. Route a mixed batch once, before any child spawn or async-job registration, and accept or reject it atomically.
- Keep the public `task` schema free of caller-controlled `model` and route identity/provenance fields. Add only `reviewOfRouteId` as the caller-supplied review reference.
- Preserve current execution when no router is registered or the router returns `null`. Refusal, timeout, malformed routing, or abort starts no child and registers no async job.
- Use a 30-second task-router deadline with the caller signal linked into the route signal. Keep a narrow exported test seam for shortening that deadline.
- Carry source-bearing extension descriptors through SDK assembly. A package entry loaded explicitly through `--plugin-dir` retains its package root/name/version and manifest defaults. An explicitly configured standalone file remains standalone and receives no inferred package authority.
- Extend `ctx.models` with canonical selection metadata: resolved authenticated model, canonical provider/id, exact thinking level, and stable vendor ID. Do not change the existing opaque comparison-only `family()` result.
- Load packaged extension defaults as defaults, not global writes. Explicit `--plugin-dir` loading is sufficient enablement; live runtime/package state remains authoritative for later implementation phases.

## Tests added

- `packages/coding-agent/test/extensibility/task-router.test.ts`
  - SDK-assembled flat and mixed-batch delivery
  - validation-before-router ordering
  - atomic batch refusal with zero spawn/registration
  - exclusive router ownership with both owners named
  - 30-second deadline, timeout abort, and caller-abort propagation
  - no-router and `null` compatibility
- `packages/coding-agent/test/extensibility/extension-source-authority.test.ts`
  - source-bearing packaged `--plugin-dir` descriptor and manifest defaults
  - standalone source remains without package authority
- `packages/coding-agent/test/extensibility/ext-model-query.test.ts`
  - canonical authenticated selector metadata, exact `max` effort, stable vendor ID, and unchanged opaque `family()`
- `packages/coding-agent/test/task/task-batch.test.ts`
  - `reviewOfRouteId` in flat and batch item schemas
  - absence of public `model`, route ID, router, and provenance controls

## Formatting

```text
$ node_modules/.bin/biome check --write packages/coding-agent/test/extensibility/task-router.test.ts packages/coding-agent/test/extensibility/extension-source-authority.test.ts packages/coding-agent/test/extensibility/ext-model-query.test.ts packages/coding-agent/test/task/task-batch.test.ts
exit 0
Checked 4 files in 20ms. Fixed 2 files.
```

## Focused RED command

```text
$ PI_COMPILED=1 /Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/extensibility/task-router.test.ts packages/coding-agent/test/extensibility/extension-source-authority.test.ts packages/coding-agent/test/extensibility/ext-model-query.test.ts packages/coding-agent/test/task/task-batch.test.ts
exit 1
23 pass
10 fail
129 expect() calls
Ran 33 tests across 4 files. [1372.00ms]
```

The ten failures are missing-contract failures:

1. Public task schemas do not expose `reviewOfRouteId` and still expose the legacy caller `model` field.
2. Loaded extensions have no `registerTaskRouter`, so SDK-assembled flat/batch calls do not reach a router.
3. Router refusal cannot yet gate a mixed batch atomically before spawn/registration.
4. Multiple routers are not rejected because router registration does not exist.
5. The 30-second router deadline and its test setter do not exist.
6. Caller abort cannot propagate to a router that cannot yet register.
7. A `null` router compatibility path cannot be observed because router registration does not exist.
8. `ctx.models.resolveSelection()` does not exist.
9. Explicit plugin-dir discovery does not return a source-bearing packaged descriptor.
10. Configured standalone discovery still returns a path string rather than a source-bearing standalone descriptor.

These failures occur at the missing public contracts or their first observable behavior. Existing tests in the same focused files continue to pass (23 passing), and no failure is from fixture setup, native loading, network access, or a paid provider.

## Concerns carried forward

- Source descriptors must survive discovery, loading, runner construction, and SDK/subagent reuse without flattening back to strings.
- The router must run after public validation but before all spawn/async side effects, including mixed batches.
- Timeout and external abort need once-only settlement and linked-signal cleanup; the RED test intentionally exercises the real platform deadline through a shortened test seam.
- Stable vendor identity must come from catalog/provider metadata, never from Regulus adapter tables, and must remain distinct from opaque `family()` values.


## Review-fix RED expansion

The final RED set supersedes the earlier counts above. It keeps production code untouched and adds independent named assertions for the review findings:

- real SDK assembly receives one initially unbound, one-shot router reference and binds it only after extension load;
- a non-null ordered mixed-batch decision reaches native execution with sealed strict selectors, while malformed, partial, overlong, reversed, refused, timed-out, and aborted routing all stop before allocation, registry/job registration, lifecycle, auth lookup where routing has not completed, or subprocess execution;
- strict preflight independently rejects selector/effort mismatch, stable-vendor mismatch, `task.maxEffort` violation, and expired live authentication; successful strict execution must suppress configured prewalk and carry the sealed selector/vendor/effort;
- unsupported router API versions and competing router owners fail during session construction;
- async `onStarted` is registration-ordered and gates child setup; start and settlement callback failures are contained, and settlement remains once-only;
- completed writers expose an opaque review reference; the reviewer receives the trusted writer descriptor, fixed strict review schema, exact assignment/output bytes, byte counts, SHA-256 digests, and one length-framed system-context segment despite delimiter-like payload text;
- packaged `--plugin-dir` sources retain validated manifest authority/defaults through loader, runner, SDK, task forwarding, and child reuse; standalone files stay authority-free; linked disable/enable and routing settings are read freshly;
- `resolveSelection()` independently requires exact effort, live authentication, canonical provider/id, and catalog-derived stable vendor IDs for Kimi through OpenRouter (`moonshot`) and Qwen through Together (`alibaba`), without changing opaque `family()`.

Final focused command:

```text
$ PI_COMPILED=1 /Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/extensibility/task-router.test.ts packages/coding-agent/test/extensibility/extension-source-authority.test.ts packages/coding-agent/test/extensibility/ext-model-query.test.ts packages/coding-agent/test/task/task-batch.test.ts
exit 1
23 pass
27 fail
145 expect() calls
Ran 50 tests across 4 files. [6.33s]
```

All 27 failed tests name absent Phase 1 contracts. There were no unhandled fixture/load errors. One lifecycle test originally waited on the deliberately missing callback and hit Bun's timeout; it was tightened to assert `started === 1` before waiting. The targeted final check now fails immediately at that missing callback contract (`expected 1`, `received 0`, 73.64 ms), rather than by timeout.

No production file was changed. No provider or paid model call ran.