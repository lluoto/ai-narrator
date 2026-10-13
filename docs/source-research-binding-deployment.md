# Source Research Binding Deployment

## Scope

The source-research endpoint is an opt-in, read-only facade. It has no
`GameSession`, state, rule, prompt, SQLite, or tool capability. Bind the
reviewed v2 manifest and the exact source-proposition-records artifact it
declares as input; calculate each SHA-256 over the complete file bytes.

Set all five values together. Partial configuration is disabled rather than
falling back to a path or hash.

```dotenv
SOURCE_RESEARCH_MANIFEST_PATH=<absolute-path-to-reviewed-v2-manifest>
SOURCE_RESEARCH_MANIFEST_SHA256=<64-lowercase-hex-sha256-of-manifest-bytes>
SOURCE_RESEARCH_RECORDS_PATH=<absolute-path-to-matched-source-records>
SOURCE_RESEARCH_RECORDS_SHA256=<64-lowercase-hex-sha256-of-records-bytes>
SOURCE_RESEARCH_ALLOWED_REVIEWER_CLASSES=delegated_assistant
```

`delegated_review_v2` contains only `delegated_assistant` reviews. Its binding
must allow `delegated_assistant`; using only `human` rejects the binding. For a
separately pinned, all-human reviewed artifact, set the explicit allowlist to
`human` instead. A separately hash-pinned artifact may include `lead_model`
only when the binding explicitly includes `lead_model` (for example,
`human,lead_model`). Do not broaden the allowlist merely to make an artifact
load.

## Smoke Test

After restarting the research host with the complete binding, make exactly one
GET request with one nonblank, exact work ID:

```sh
curl -i "<research-base-url>/api/source-research?workId=<exact-work-id>"
```

Expect `200` with `status.readOnly: true`, `status.noRuntimeEffect: true`, and
only receipts for that work. Additional query parameters are rejected; request
bodies are neither read nor interpreted. Non-GET methods return `405` with
`Allow: GET`.

Before configuration, or when any of the five values is blank, the same GET
returns `503` with `SOURCE_RESEARCH_UNAVAILABLE`. Invalid pins, unreadable
artifacts, or a reviewer class outside the allowlist return `503` with
`SOURCE_RESEARCH_BINDING_REJECTED`; do not expose paths or pins in responses.

## Admission Record

Record any selected current candidate rows as a standalone
`research_lookup_admission`. Use candidate IDs from the pinned manifest and
map every selected candidate to its one exact work ID. Create and retain the
canonical, frozen record through `createSourcePublicationDecision`:

```ts
const decision = createSourcePublicationDecision({
  schema_version: SOURCE_PUBLICATION_DECISION_SCHEMA_VERSION,
  decision_kind: "research_lookup_admission",
  reviewed_source_manifest_hash: "<manifest-sha256>",
  source_records_hash: "<records-sha256>",
  selected_candidate_ids: ["<candidate-id>"],
  work_scope: {
    work_id: "<exact-work-id>",
    candidate_work_ids: { "<candidate-id>": "<exact-work-id>" },
  },
  decision_authority: {
    authority_class: "delegated_assistant", // "lead_model" is research-only; use "human" for runtime authority.
    authority_id: "<authority-identifier>",
  },
  timestamp: "<canonical-iso-8601-utc-instant>",
  supersedes: null,
  runtime_effect: false,
  approved_ruleset_contract_hash: null,
});
```

`runtime_rule_admission` is prohibited for current candidate manifests,
including `delegated_review_v2`. Do not set `runtime_effect: true`, add a
ruleset-contract hash, or route these receipts into runtime behavior. The
decision record is an isolated audit artifact, not runtime wiring.

## Verification

For this documentation-only deployment change, run the focused boundary tests:

```sh
bun test src/__tests__/source-research-http.test.ts src/__tests__/source-research-facade.test.ts src/__tests__/source-publication-decision.test.ts
```
