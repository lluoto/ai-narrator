# Production Round 1 Offline Audit

Review only. No runtime, promotion, API calls, or production writes.

Original and reverify evidence remain separate. **Precedence is unresolved.**
No-work is a scheduler result, not extraction coverage. Quality certification is not established.

## Original Evidence

| Metric | Wave-A | Foundation |
|---|---:|---:|
| Books | 124 | 6 |
| No-work books | 3 | 0 |
| Transport-completed books | 121 | 6 |
| Verification-complete books | 41 | 5 |
| Quality-certified books | 0 | 0 |
| Eligible windows | 9828 | 572 |
| Generator windows | 9828 | 572 |
| Generator parse-failure windows | 5 | 0 |
| Proposed cards | 22846 | 1286 |
| Accepted cards | 19124 | 1143 |
| Schema/span-rejected cards | 3722 | 143 |
| Verifier rows | 19124 | 1143 |
| Logical calls | 28952 | 1715 |
| Transport-failure rows | 0 | 0 |

wave_a recorded partition: `{"contradicted": 243, "entailed": 3815, "insufficient": 14630, "unusable": 436}`.
wave_a independently audited partition: `{"contradicted": 243, "entailed": 3815, "insufficient": 14630, "unusable": 436}`.
wave_a finish reasons: `{"length": 286, "stop": 28666}`.

foundation recorded partition: `{"contradicted": 17, "entailed": 507, "insufficient": 618, "unusable": 1}`.
foundation independently audited partition: `{"contradicted": 17, "entailed": 507, "insufficient": 618, "unusable": 1}`.
foundation finish reasons: `{"stop": 1715}`.

## Reverify Evidence

| Cohort | Books | Rows | Recorded Partition | Conflicts |
|---|---:|---:|---|---:|
| wave_a | 8 | 1019 | `{"contradicted": 15, "entailed": 198, "insufficient": 799, "unusable": 7}` | 332 |
| foundation | 6 | 1143 | `{"contradicted": 6, "entailed": 148, "insufficient": 976, "unusable": 13}` | 381 |

Compared 14 independent outputs across 2521 card IDs; 713 per-card status conflicts. No attempt selected as authoritative.

## Repair And Evidence

- Verifier repair queue: 457 exact persisted attempt rows.
- Generator repair queue: 3870 rows; kinds: `{"generator_window": 5, "schema_or_span_rejection": 3865}`.
- Per-book quality gaps: 130 JSONL rows.
- Reported-versus-actual metadata mismatches: 0.
- Historical input-hash mismatches: 0.
- Read inputs hashed: 2706; unresolved references: 0.
- Historical 3-book/6-book summaries are not a 130-book first-round inventory; numeric evidence is retained in report.json.
- The six-book summary reports 507 + 618 + 17 = 1,142 verdicts for 1,143 verifier rows; the missing partition is one unusable row.
- Historical source aliases are resolved by exact content hash, without guessing source-version precedence.
- Persisted WSL source pointers are mapped to their corresponding local Windows paths; any unresolved paths are listed in report.json.
- Raw errors are retained as codes with file/row/response hashes, never source or model prose.
- Rejected generator cards and invalid-JSON generator windows are not conflated with verifier failures.

## Checks And Reproduction

Checks: 13955/13955 passed; 0 failed.

Run `python audit_round1.py --check` from this directory for offline byte-for-byte reproduction without writes.
Initial generation is absent-only: `python audit_round1.py` refuses existing generated products.
See manifest.json for definitions, unresolved precedence, exact scope and limitations.
