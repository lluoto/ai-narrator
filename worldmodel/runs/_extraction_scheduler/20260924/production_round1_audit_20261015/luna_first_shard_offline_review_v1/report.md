# Luna First-Shard Offline Audit

Status: PASS_WITH_NOTES

Errors: 0; gaps: 0; notes: 5.

## Scope

Independent offline accounting/integrity/validation only. No source prose or verdict summaries copied.
Historical result files, ledger, manifests, STATE and source are not edited.
All four requested external anchors are fixed in audit.py and pins.json.

## Counts

Parent: 713 cases, 14 works, 37 work-scoped shards, exact-once membership.
First shard: 24 cases; work: `"80\u5929\u5f81\u670d\u9b54\u90fd"`.
Revision 2 ledger: 24 completed, 689 unreviewed; wrong work: 0.
Schema: 24/24; actual contextual/citation/scope validator: 24/24.
All five dimensions exactly once: 24/24.

Judgments: `{"insufficient": 1, "needs_context": 1, "supported": 22}`.
Recommendations: `{"undecided": 24}`.
Support scopes: `{"both": 5, "new_review_context_only": 6, "none": 1, "prior_sent_evidence": 12}`.

| Dimension | Supported | Insufficient | Contradicted | Needs Context |
| --- | ---: | ---: | ---: | ---: |
| source_fidelity | 23 | 0 | 0 | 1 |
| modality | 22 | 2 | 0 | 0 |
| temporal | 23 | 1 | 0 | 0 |
| actor_attribution | 24 | 0 | 0 | 0 |
| route | 24 | 0 | 0 | 0 |

## Notes

- NOTE `DIMENSION_GLOBAL_PRECEDENCE_UNDEFINED`: Existing schema/context validator does not define dimension-to-global precedence. Labels retained without conversion; semantic acceptance not inferred.
- Supported global judgments with insufficient dimension(s): 2; multiple insufficient dimensions: 0.
- NOTE `HISTORICAL_LEDGER_CORRECTED`: Historical manifest and ledger preserved. Revision 2 fixes only wrong work_id on unreviewed rows; 47 is one true-work cohort, not the total.
- NOTE `REVISION2_REFERENCE_SCOPE`: Revision 2 directly hash-declares shard, corrected ledger and correction note only. Summary/input/executor and original ledger are hash-bound through its superseded historical manifest, not directly listed by revision 2.
- NOTE `VALIDATION_NOT_SEMANTIC_ACCEPTANCE`: Structural, identity-field, citation namespace and support-scope validation is not semantic support verification, human gold, quality certification, precision or recall.
- NOTE `DECLARED_FLAGS_NOT_GLOBAL_PROOF`: Boundary flags are declarations only. No global pointer search or before/after effective-pointer baseline exists; no proof of historical runtime/pointer non-change or executor transport identity is claimed.

## Historical Correction

Original ledger wrong-work rows: 685; corrected rows: 685.
Original first-shard verdict and both summaries match historical hash declarations. Original ledger/manifest are retained as historical revision.
Per-work counts and metadata-only case findings are in report.json; no semantic rejudgment was performed.

## Stability And Replay

Inputs stable before/after final hash: True; files: 66.
Structural backend: `jsonschema.Draft202012Validator`; no dependency installation.
From this audit directory: `python -B audit.py --check` regenerates report.json/report.md/pins.json in memory and compares exact bytes without writing.
For a new report only: `python -B audit.py --generate` exclusively creates absent report files in this audit directory.
Python/jsonschema environment is recorded, not vendored. --check fails on changed input/code/backend or output bytes.
Stability covers recorded local files, not a filesystem snapshot or global historical non-change proof.
