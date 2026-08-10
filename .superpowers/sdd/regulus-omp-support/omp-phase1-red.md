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
- `packages/coding-agent/test/extensibility/task-router-phase2.test.ts`
  - quarantined strict-preflight, lifecycle, settlement, writer-review, and pre-truncation receipt contracts
- `packages/coding-agent/test/extensibility/extension-source-authority.test.ts`
  - source-bearing packaged `--plugin-dir` descriptor, validated enum defaults (`routingMode: off`), and invalid-schema refusal
  - standalone source remains without package authority
  - real nested SDK/subagent session rebuild inherits packaged authority; restricted/isolation reset clears it
- `packages/coding-agent/test/extensibility/ext-model-query.test.ts`
  - separate functional and configured-but-nonfunctional Kimi/Qwen cases that keep the same model in `getAvailable()`
  - exact credential-probe invocation and result, canonical selector metadata, exact effort, catalog-derived stable vendor ID, and unchanged opaque `family()`
- `packages/coding-agent/test/task/task-batch.test.ts`
  - `reviewOfRouteId` in flat and batch item schemas
  - absence of public `model`, route ID, router, and provenance controls

## Formatting

```text
$ node_modules/.bin/biome check --write packages/coding-agent/test/extensibility/task-router.test.ts packages/coding-agent/test/extensibility/task-router-phase2.test.ts packages/coding-agent/test/extensibility/ext-model-query.test.ts
exit 0
Checked 3 files in 41ms. Fixed 1 file.
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

1. Public task schemas do not expose `reviewOfRouteId`; the existing closed schemas already omit legacy caller-controlled route identity fields.
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

The authoritative Phase 1 gate supersedes the earlier counts above. It keeps production code untouched and adds independent named assertions for the Phase 1 review findings:

- real SDK assembly receives one initially unbound, one-shot router reference and binds it only after extension load;
- a complete non-null ordered mixed-batch decision is validated and attached through the actual SDK/`TaskTool` route handoff, while malformed, partial, overlong, reversed, refused, timed-out, and aborted routing all stop before allocation, registry/job registration, auth lookup where routing has not completed, or subprocess execution;
- unsupported router API versions and competing router owners fail during session construction;
- packaged `--plugin-dir` sources use real enum manifest grammar, reject invalid setting schemas, retain validated authority/defaults through loader and SDK forwarding, and enter a real nested session rebuild; only the child prompt is stopped after rebuilding, rather than mocking descriptor reuse;
- restricted nested execution proves extension-isolation resets clear inherited authority;
- linked disable/enable and routing settings are read freshly;
- `resolveSelection()` has four independent Kimi/Qwen credential-working/credential-missing cases. Both states keep the model in `getAvailable()` and assert the exact `getApiKey()` probe, so deriving `authenticated` from list membership cannot pass.

Authoritative Phase 1 focused command:

```text
$ PI_COMPILED=1 /Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/extensibility/task-router.test.ts packages/coding-agent/test/extensibility/extension-source-authority.test.ts packages/coding-agent/test/extensibility/ext-model-query.test.ts packages/coding-agent/test/task/task-batch.test.ts
exit 1
23 pass
23 fail
135 expect() calls
Ran 46 tests across 4 files. [2.69s]
```

All 23 Phase 1 failures stop at absent Phase 1 contracts or their first observable behavior. The nested forwarding tests currently stop at the missing packaged descriptor; once that contract exists they continue through real `TaskTool` execution and real child `createAgentSession` reconstruction. No failure is a syntax, native-load, network, or paid-provider failure.

## Phase 2 RED quarantine

Strict provider execution, sealed `ResolvedStrictRouteSelection`, prewalk suppression, lifecycle callbacks, and review-receipt contracts are intentionally isolated from the Phase 1 green gate in `packages/coding-agent/test/extensibility/task-router-phase2.test.ts`. Phase 1 asserts only complete decision validation/order and the hidden route handoff. The oversized receipt fixture bypasses that absent Phase 1 wiring with a test-owned route stub: it seeds ordered writer and review requests plus `route-0`/`review-0` decisions before invoking the real task tool. Its fake terminal yield sets `useLastTurn: true`, so the multibyte sentinel-bearing assistant output above 500,000 bytes enters the actual `TaskTool` and `runSubprocess`/`finalizeRunResult` path without a null-yield warning.

The focused oversized-output run proves `SingleResult.output` is truncated before reaching the intended missing receipt/review-frame contract: its truncation, head removal, and tail retention assertions pass, as do the smaller model-preview and no-null-warning assertions. Explicit preconditions also prove both seeded route requests, both route decisions, and the second request item exist. The sole RED failure is that the existing review request lacks the receipt-linked `reviewTarget`.

```text
$ PI_COMPILED=1 /Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/extensibility/task-router-phase2.test.ts --test-name-pattern "captures finalized full UTF-8 writer bytes"
exit 1
0 pass
9 filtered out
1 fail
14 expect() calls
Ran 1 test across 1 file. [1017.00ms]
```

```text
$ PI_COMPILED=1 /Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/extensibility/task-router-phase2.test.ts
exit 1
0 pass
10 fail
27 expect() calls
Ran 10 tests across 1 file. [1150.00ms]
```

These ten Phase 2 failures are recorded now but are not part of the Phase 1 green criterion. They cover successful sealed-selection execution, strict effort/vendor/max-effort/live-auth refusal, delayed and failed lifecycle callbacks, once-only settlement, end-to-end writer/reviewer framing, and full-output receipt capture before `truncateTail`.

No production file was changed. No provider or paid model call ran.