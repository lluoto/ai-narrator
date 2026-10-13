# Source Research Facade

## Status And Boundary

`src/world/source-research-facade.ts` is a read-only facade over the reviewed
source-query adapter. Construction requires an explicit, hash-pinned binding:
`manifestPath`, `manifestSha256`, `sourceRecordsPath`,
`sourceRecordsSha256`, and a nonempty `allowedReviewerClasses` allowlist. It
does not read environment variables, choose artifact paths, or accept runtime
capabilities.

`facade.query({ workId })` requires one nonblank work ID and returns a frozen
`SourceResearchResult`: its `receipts` are immutable `SourceResearchReceipt[]`
and its `status` declares `noRuntimeEffect: true` and `readOnly: true`. The
facade rejects expanded query fields and exposes no write API. Common dynamic
mutation calls, including `mutate`, `write`, `update`, `delete`, `commit`, and
`execute`, fail with `SourceResearchFacadeError`.

The binding fails closed when either artifact hash differs, a manifest record
has no runtime-effect declaration, a record crosses its manifest work scope,
or any reviewed row has a reviewer class outside the caller's allowlist. It
also refuses mutable receipt structures from its wrapped adapter. `lead_model`
reviews are admitted only when that class is explicitly included in the
hash-pinned binding's allowlist.

This is research output only. It is not wired to `GameSession`, world-model
integration, prompts, rules, SQLite, or tool calls. No facade operation can
create game facts, inject prompt context, execute a rule, or mutate
persisted/runtime state.

## Opt-In HTTP Facade

`src/api/source-research-http.ts` is an isolated API facade that recognizes
only `GET /api/source-research?workId=<exact-work-id>`. It constructs the
existing facade only after all five nonblank configuration values exist:
`SOURCE_RESEARCH_MANIFEST_PATH`, `SOURCE_RESEARCH_MANIFEST_SHA256`,
`SOURCE_RESEARCH_RECORDS_PATH`, `SOURCE_RESEARCH_RECORDS_SHA256`, and
`SOURCE_RESEARCH_ALLOWED_REVIEWER_CLASSES`. The reviewer list is an explicit
comma-separated allowlist. Paths and SHA-256 pins are always supplied by the
caller; none are embedded in code or docs.

Without complete configuration it returns `503` with
`SOURCE_RESEARCH_UNAVAILABLE` before constructing the facade or reading either
artifact. A supplied but invalid binding, including a hash mismatch or a
non-allowlisted reviewed row, returns `503`
`SOURCE_RESEARCH_BINDING_REJECTED` without exposing artifact paths or pins.

The exact endpoint accepts one nonblank `workId` query key and no others.
Repeated `workId`, `text`, `route`, and every other query field return `400`
`SOURCE_RESEARCH_QUERY_INVALID`. Every method other than `GET` returns `405`
with `Allow: GET`; request bodies are neither read nor interpreted. A success
returns only the facade's immutable status and receipts, marked read-only and
`noRuntimeEffect`.

This module is intentionally an equivalent API facade rather than a
`GameSession` server route: a research-only host may call
`handleSourceResearchHttpRequest(request)`, while unrelated POC HTTP handling
cannot supply it with state, prompt, rule, SQLite, action, or tool capability.

## Optional Artifact Smoke Test

`src/__tests__/source-research-facade.test.ts` has an opt-in v2 artifact test.
It runs only when all six explicit values are present: `SOURCE_RESEARCH_MANIFEST_PATH`,
`SOURCE_RESEARCH_MANIFEST_SHA256`, `SOURCE_RESEARCH_RECORDS_PATH`,
`SOURCE_RESEARCH_RECORDS_SHA256`, `SOURCE_RESEARCH_ALLOWED_REVIEWER_CLASSES`,
and `SOURCE_RESEARCH_WORK_ID`. Hashes are supplied by the caller; the test does
not calculate pins from artifact paths or embed machine-specific paths.
