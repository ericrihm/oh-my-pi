# Task 4: Archive-aware readers and private-path exclusions

## Changed files

- `packages/coding-agent/src/session/fanout-archive.ts`
- `packages/coding-agent/src/session/artifacts.ts`
- `packages/coding-agent/src/internal-urls/artifact-protocol.ts`
- `packages/coding-agent/src/internal-urls/history-protocol.ts`
- `packages/coding-agent/src/internal-urls/registry-helpers.ts`
- `packages/coding-agent/src/registry/persisted-agents.ts`
- `packages/coding-agent/src/cli/gc-cli.ts`
- `packages/coding-agent/test/internal-urls/fanout-archive-reader.test.ts`
- `packages/coding-agent/test/gc-cli.test.ts`
- `.superpowers/sdd/fanout-resilience/task-4-report.md`

## RED evidence

Command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/internal-urls/fanout-archive-reader.test.ts -t 'keeps compact history and artifact identities stable'
```

Output before implementation:

```text
0 pass
1 fail
Ran 1 test across 1 file.
```

The test failed at `artifact://17` with `Artifact 17 not found. Available: none`, demonstrating that active-directory scanning could not resolve a published archive spill.

The GC exclusion test was added before its implementation but passed on the prior Bun Glob behavior because dot-prefixed directories were already omitted implicitly. The production traversal was nevertheless replaced with explicit `.fanout-archive` pruning so the exclusion is intentional and applies uniformly to JSONL, compressed JSONL, and backup scans.

## Implementation

- Added mutex-protected published-manifest validation in `FanoutArchiveManager`, including a specific `FanoutArchiveCorruptionError`, archive transcript resolution, and archive artifact indexing rebuilt after recovery.
- Kept active artifacts and transcripts authoritative; archive lookups occur only after active lookup misses. A parked ref whose relocated active file is absent now falls back to the published transcript.
- Kept compact `<id>.md` files active and unchanged. Archive readers expose only validated files under `entries/<child>/`; staging and transaction journals are never scanned.
- Added archive-backed `ArtifactManager.getPath`, `artifact://` path resolution, and artifact completion while preserving numeric artifact IDs.
- Excluded `.fanout-archive` from generic transcript discovery, persisted-child registration, and GC recursive JSONL scans.

## GREEN evidence

Task 4 focused command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/internal-urls/fanout-archive-reader.test.ts packages/coding-agent/test/internal-urls/history-protocol.test.ts packages/coding-agent/test/internal-urls/artifact-path-only.test.ts packages/coding-agent/test/gc-cli.test.ts
```

Output:

```text
63 pass
0 fail
239 expect() calls
Ran 63 tests across 4 files.
```

Directly implicated Task 1-3 archive lifecycle contract:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/session/fanout-archive.test.ts
```

Output:

```text
13 pass
0 fail
40 expect() calls
Ran 13 tests across 1 file.
```

## Self-review and limitations

- Reviewed archive lookup order and verified active files are searched before every archive entry; direct archived reads remain read-only and never inspect `.staging` or `.txn`.
- Archive manifest validation requires the expected transcript, tombstone, and regular spill files. A missing or malformed published entry produces a specific corruption error for direct history/artifact resolution when no active copy exists.
- This task intentionally does not implement Task 5+ admission, reservation, or child-creation behavior. No formatter, linter, build, full suite, commit, or push was run.

## Review follow-up

Added focused RED coverage for resumed archived ID allocation, pinned-parent archive precedence over another session's active collision, and case-insensitive archived history/Agent Hub availability.

RED command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/internal-urls/fanout-archive-reader.test.ts -t 'reserves archived artifact IDs|prefers the pinned parent|keeps archived transcripts case-insensitive'
```

RED output:

```text
0 pass
3 fail
Ran 3 tests across 1 file.
```

The failures respectively allocated `0` instead of `18`, returned the other session's active artifact, and rejected lowercase `history://dead` as an invalid archived manifest lookup.

The fix reserves every validated archived numeric ID before allocation and propagates archive corruption; resolves pinned active then pinned archive before any other session; adds exact-first deterministic case-insensitive archive history lookup; and recognizes published archived transcripts in availability checks without registering or reviving them.

Final GREEN command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/internal-urls/fanout-archive-reader.test.ts packages/coding-agent/test/internal-urls/history-protocol.test.ts packages/coding-agent/test/internal-urls/artifact-path-only.test.ts packages/coding-agent/test/gc-cli.test.ts && /Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/session/fanout-archive.test.ts
```

Final GREEN output:

```text
66 pass
0 fail
245 expect() calls
Ran 66 tests across 4 files.

13 pass
0 fail
40 expect() calls
Ran 13 tests across 1 file.
```

## Allocation-race follow-up

`ArtifactManager` now completes its active artifact scan before it asks the parent archive manager for validated archived IDs. This serializes the two snapshots: an in-flight publication either remains visible in the active scan or completes before the archive lookup acquires the parent mutex.

The fixture injects a delayed active scan and an archive manager whose first snapshot returns no IDs. With the former concurrent scan, both snapshots observe no `18` and allocation reuses `0`; the serialized scan sees active `18` before it queries the archive and allocates `19`.

RED command, run while temporarily restoring only the prior two-line `Promise.all` scan:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/internal-urls/fanout-archive-reader.test.ts -t 'does not reuse an artifact ID when publication lands'
```

RED output:

```text
0 pass
1 fail
Expected: "19"
Received: "0"
Ran 1 test across 1 file.
```

The sequential scan was restored before final verification.

Final verification command:

```sh
/Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/internal-urls/fanout-archive-reader.test.ts packages/coding-agent/test/internal-urls/history-protocol.test.ts packages/coding-agent/test/internal-urls/artifact-path-only.test.ts packages/coding-agent/test/gc-cli.test.ts && /Users/eric/.cache/omp-bun/node_modules/.bin/bun test packages/coding-agent/test/session/fanout-archive.test.ts
```

Output:

```text
67 pass
0 fail
246 expect() calls
Ran 67 tests across 4 files.

13 pass
0 fail
40 expect() calls
Ran 13 tests across 1 file.
```
