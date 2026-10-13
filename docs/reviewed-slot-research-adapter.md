# Reviewed Slot Research Adapter

## Status And Boundary

`src/world/reviewed-slot-research-adapter.ts` is a standalone, read-only loader
for the real `reviewed_slot_research_manifest_v1.jsonl` schema produced by the
2026-09-24 worldmodel run. It is not the source-query adapter and does not
import, configure, or alter the source-research facade.

The adapter is exposed only through the separate GET-only
`/api/slot-research?workId=<exact-work-id>` facade. It is not connected to
`GameSession`, world state, rules, SQLite, prompts, actions, or a world-model
loader/integrator. No consumer other than that existing isolated HTTP facade
may be added without a new boundary decision.

Receipts are frozen metadata only: identifiers, hashes, single-work/source
scope, route, and modality scope. The adapter never returns proposal text,
lead rationale, canonical-verdict contents, source sentences, rewrite payloads,
or runtime authority. It reads the proposal and dossier JSONL files only to
verify referenced record/line hashes and promptly discards decoded rows.

## Accepted Manifest

The only accepted record shape is the closed schema at:

`D:\aitrpg\世界模型\worldmodel\runs\_extraction_scheduler\20260924\slot_batch_v4_8001_reviewed_slot_research_manifest_v1\manifest_schema.json`

It has exactly these top-level fields:

```json
{
  "source_parent_hashes": {},
  "proposal": {},
  "verifier": {},
  "lead_dossier": {},
  "work_source": {},
  "route": "bounded_event",
  "modality_scope": {},
  "reviewer_class": "lead_model",
  "publication_status": "candidate_not_confirmed",
  "transfer_policy": "no_transfer",
  "consumer_policy": "research_lookup_only",
  "no_runtime_effect": true
}
```

`work_source.allowed_work_ids` must be exactly `[work_source.work_id]`. The
fixed reviewer, publication, transfer, consumer, extractability, and runtime
boundary values are checked for every row. The former synthetic fields
`proposal_artifact`, `verifier_artifact`, `dossier_artifact`, `work_scope`,
`manifest_record_id`, and `schema_version` are rejected rather than adapted.

The production manifest is pinned by its caller and is recorded by the adjacent
`manifest.json` as SHA-256
`12786a785aec23e396705996c473713716f3f5957e491019a08a852a4560ed94`.
Its metadata describes 79 retained research rows, a strict no-runtime boundary,
and the schema pin. The adapter validates the same closed record shape; it does
not treat `manifest.json` as a substitute for a manifest-byte pin.

## Binding Index

The manifest deliberately stores opaque hashes, not filesystem locations. A
deployment must provide a separate JSON binding index, pin that file's complete
SHA-256 independently, and bind it to the same manifest SHA-256:

```json
{
  "schema_version": "reviewed_slot_research_artifact_binding_index_v1",
  "manifest_sha256": "12786a785aec23e396705996c473713716f3f5957e491019a08a852a4560ed94",
  "bindings": [
    {
      "reference_sha256": "<manifest-referenced-full-file-sha256>",
      "path": "<absolute-read-only-artifact-path>",
      "file_sha256": "<the-same-64-lowercase-hex-sha256>"
    }
  ]
}
```

The index is closed. Every binding must be unique, its `file_sha256` must equal
its `reference_sha256`, and its path's complete bytes must match that hash.
The index must contain exactly the hashes used by the configured manifest: no
missing, duplicate, ambiguous, or unrelated binding is accepted.

For this concrete 79-row manifest, the index contains 85 bindings:

- The parent batch manifest: `runs/_extraction_scheduler/20260924/slot_batch_v4_8001/batch_manifest.json`, hash `995ca2cfc1f744cda9a285f2ced221ef83190b22fe4bc00c30da5fecc829c24a`.
- Source proposition records: `runs/_extraction_scheduler/20260924/source_proposition_records_v2.jsonl`, hash `2e12abad94764b735f8ee3a3a66fe9726654754800ba6352d4bf4bdc700850ac`.
- Source sentences: `runs/_extraction_scheduler/20260924/d01_proposition_corpus_v2.csv`, hash `1959fe7859af7192e78103d7dd037bfe1d0a69754145997f4558aabc345d7489`.
- Proposal records: `runs/_extraction_scheduler/20260924/slot_batch_v4_8001_execution_v2_soft_lint/execution_output/proposal_generation_records.jsonl`, hash `e0e5d114bbe0ff36de7330c340948d1b1a6a9db4c5056a3bdcc0b3432d91c32f`.
- Tranche dossiers: `runs/_extraction_scheduler/20260924/slot_batch_v4_8001_lead_review_tranche_v1/lead_review_dossiers.jsonl`, hash `f7ef406363715ad351c5b65a4bff66722cacd5fb2570f905d1d6c6a359e5351d`.
- Remaining dossiers: `runs/_extraction_scheduler/20260924/slot_batch_v4_8001_lead_review_remaining_v1/lead_review_dossiers.jsonl`, hash `f84185bae4d180ba0a3091355b1283df139ae81c401a5ba3543bad5d9b2bb4ad`.
- The 79 row-specific canonical verdict files. Each entry must use that row's
  `verifier.canonical_verdict_sha256` and the corresponding absolute path below
  `runs/_extraction_scheduler/20260924/slot_batch_v4_8001_verifier_batch_v5_3/execution_output/cases/<ordinal>_<case_id>/canonical_verdict.json`.

Do not add all 90 verifier files. The index must include only the 79 canonical
verdict hashes referenced by this retained manifest. The authoritative
case-to-path mapping is `slot_batch_v4_8001_verified_review_queues_v1/lead_review_queue.jsonl`;
the verifier case directory ordinal is `01` through `90` in that queue's case
order. All paths must be mounted read-only in a deployment.

For each row, loading proves all of the following before a receipt exists:

- The proposal-records file resolves through its full-file hash and its exact
  `proposition_id` line matches `proposal_record_sha256` (without the line
  terminator, matching the producer's verifier).
- The row's canonical-verdict hash resolves to one independently full-file
  pinned artifact.
- The dossier file hash resolves to exactly one of the two bound dossier files,
  and its exact `review_dossier_id` line matches `dossier_line_sha256`
  (including its line terminator, matching the producer).
- Every source-parent hash resolves to a full-file-pinned binding.

## Opt-In HTTP Facade

`src/api/slot-research-http.ts` recognizes only
`GET /api/slot-research?workId=<exact-work-id>`. It binds the adapter only when
all five values are nonblank. The facade is default-off: leave all five unset
to keep it unavailable. Restart the server after changing any binding because
the process environment is captured when the handler is initialized:

```dotenv
SLOT_RESEARCH_MANIFEST_PATH=<absolute-path-to-reviewed-slot-manifest>
SLOT_RESEARCH_MANIFEST_SHA256=<64-lowercase-hex-sha256-of-manifest-bytes>
SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_PATH=<absolute-path-to-binding-index-json>
SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_SHA256=<64-lowercase-hex-sha256-of-index-bytes>
SLOT_RESEARCH_ALLOWED_REVIEWER_CLASSES=lead_model
```

There are no per-artifact environment variables and no default paths. Missing
or partial configuration returns `503 SLOT_RESEARCH_UNAVAILABLE` without
loading artifacts. Invalid pins, unreadable artifacts, invalid rows, or an
unresolved/ambiguous index return generic `503 SLOT_RESEARCH_BINDING_REJECTED`
without paths, pins, or validation details.

The endpoint accepts exactly one nonblank `workId` key and no other query keys.
Repeated keys or extra query input return `400 SLOT_RESEARCH_QUERY_INVALID`.
Other methods return `405` with `Allow: GET`. Successful responses contain only
metadata receipts plus `{ readOnly: true, noRuntimeEffect: true }`; they cannot
affect sessions, state, rules, prompts, actions, SQLite, or runtime wiring.

## Optional Actual Smoke

The default test suite never reads worldmodel artifacts. To smoke the exact
2026-09-24 manifest, prepare the complete 85-entry index above, set the five
binding values above, and set `SLOT_RESEARCH_RUN_WORLDMODEL_SMOKE=true`. The
opt-in test then loads the configured manifest and verifies all 79 receipts
across its three exact work IDs. It fails if any index binding, file hash,
proposal record, verifier artifact, or dossier line cannot be proven.
