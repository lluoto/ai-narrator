# Approved Source Resolution Status

## Authorization And Limits

User instruction: `1，2批准`. Execution applies the two decisions described in
`SOURCE_RESOLUTION_DECISION_REQUEST.md`: exact data-identity sidecars for the 83
candidate works and an independent byte-identical-row deduplicated snapshot for
`网游之射破苍穹`. The instruction grants no Qwen dispatch budget, semantic
certification, tier/publication decision, cross-work transfer, or runtime effect.

## Materialized Products

Paths below are relative to the worldmodel root:

| Product | Path | Manifest SHA256 |
| --- | --- | --- |
| 83 approved exact source identities | `runs/_extraction_scheduler/20260924/source_identity_bindings_approved_v1/` | `69edf31249b31bd6fbc05768169b5eda3a15dc8ef547bc1bcb34bd7fd3e401d2` |
| Derived duplicate-free source and complete occurrence lineage | `runs/_extraction_scheduler/20260924/source_deduplication_approved_v1/网游之射破苍穹/` | `45dfc18bc3f91dd2bbecab72da00f3e3cdd70f6050dd62b17d580d306b26eac8` |
| Binding-aware generation follow-up inventory | `runs/_extraction_scheduler/20260924/generation_followup_inventory_v3/` | `9186fb0fa64e5d38b5cc1c4528e545882cc898f72b39ef41986c086ea0715d36` |

The identity declarations are new user approvals, not recovered historical
metadata or human source review. Each binding requires the exact tuple of named
work, ORIGINAL source-file SHA256 and local ID. There is no global B001 alias.

## Deduplication

```text
original: 99683 rows / 69550897 bytes
derived: 71258 rows / 49744722 bytes
removed byte-identical occurrences: 28425
lineage records: 99683
```

Original SHA256:
`d33080a35bd8a0a07b6a497079b475f289af6cecafbb269d1b71e6930ae6fdbd`

Derived SHA256:
`943fbb95a0226b22978379fd80ce6794e18995f3d3e01b244f97af50ed534afe`

The earliest physical occurrence is retained as an exact raw record, including
its terminator; every original occurrence maps to its derived row. Original
character offsets, text and provenance fields are unchanged. The original file
remains intact. The derived hash is NOT covered by the 83 identity bindings and
does not replace the source snapshot of historical generator calls.

## New Inventory

| Partition | Windows | Original queue entries | Rejected cards |
| --- | ---: | ---: | ---: |
| Regeneration candidates | 3169 | 3816 | 3811 |
| Offline disposition/no generation | 0 | 0 | 0 |
| Deferred | 47 | 54 | 54 |
| Total | 3216 | 3870 | 3865 |

All 983 previously resolved candidate windows remain. The 83 approved exact
bindings permit another 2186 windows to pass data-identity checks, not semantic
acceptance. The original grouping/source hashes remain unchanged.

`网游之射破苍穹` remains deferred (47 windows): malformed upstream metadata
and unresolved named-work binding are separate from duplicate byte identity.
Deduplication does not settle those issues or authorize replacing historical
source bindings.

## Consumer Boundary

The V3 inventory explicitly opts into the approved helper and uses ephemeral
work-scope projections only after exact binding validation. It never rewrites
the original source rows or relaxes the strict core globally. V1/V2 inventories
are retained; supersession is diagnostic only.

Current generic literal preparation and verifier packaging do not automatically
understand these new sidecars. They need a separate explicit binding-aware
preparation path before those windows can be packaged. Do not apply a global
work-ID replacement or substitute the derived source hash in old jobs.

3169 is a conditional candidate-window bound, NOT an approved batch or actual
model-request count. No completion/health requests were sent and no production
pipeline, source, prompt, config, STATE or existing queue was overwritten.

## Verification

Actual materialization and externally pinned reconstruction/check succeeded for
all three products. Independent review verified exact approved scope and every
original/derived occurrence mapping, with no concrete remaining defect found in
the two materializers. Original source/job/metadata hashes remained intact.

Latest Windows offline suite:

```text
548 tests
546 passed
2 symlink-privilege skips
0 failures
```

No live model quality, native POSIX execution, hard-crash or power-loss durability
is claimed. The two materializers do not use explicit fsync; partial artifacts
without a completed manifest must not be treated as finalized products.
