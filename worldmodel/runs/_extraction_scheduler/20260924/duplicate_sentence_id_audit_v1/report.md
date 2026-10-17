# Offline Duplicate Sentence-ID Audit

Proposal only. No source mutation, resolution, namespace mapping or quality certification.

## Counts

```json
{
  "affected_window_duplicates": {
    "category_groups": {
      "byte_identical_rows": 153,
      "conflicting_rows": 0,
      "json_semantically_identical_rows": 0,
      "malformed": 0
    },
    "category_rows": {
      "byte_identical_rows": 306,
      "conflicting_rows": 0,
      "json_semantically_identical_rows": 0,
      "malformed": 0
    },
    "duplicate_id_groups": 153,
    "excess_id_occurrences": 153,
    "multiplicity_histogram": {
      "2": 153
    },
    "rows_in_duplicate_groups": 306
  },
  "duplicates_not_referenced_by_affected_windows": {
    "category_groups": {
      "byte_identical_rows": 28272,
      "conflicting_rows": 0,
      "json_semantically_identical_rows": 0,
      "malformed": 0
    },
    "category_rows": {
      "byte_identical_rows": 56544,
      "conflicting_rows": 0,
      "json_semantically_identical_rows": 0,
      "malformed": 0
    },
    "duplicate_id_groups": 28272,
    "excess_id_occurrences": 28272,
    "multiplicity_histogram": {
      "2": 28272
    },
    "rows_in_duplicate_groups": 56544
  },
  "full_source": {
    "blank_rows": 0,
    "bytes": 69550897,
    "distinct_sentence_ids": 71258,
    "full_forward_scans": 1,
    "malformed_rows": 0,
    "nonblank_rows": 99683,
    "physical_lf_rows": 99683,
    "valid_sentence_rows": 99683
  },
  "whole_file_duplicates": {
    "category_groups": {
      "byte_identical_rows": 28425,
      "conflicting_rows": 0,
      "json_semantically_identical_rows": 0,
      "malformed": 0
    },
    "category_rows": {
      "byte_identical_rows": 56850,
      "conflicting_rows": 0,
      "json_semantically_identical_rows": 0,
      "malformed": 0
    },
    "duplicate_id_groups": 28425,
    "excess_id_occurrences": 28425,
    "multiplicity_histogram": {
      "2": 28425
    },
    "rows_in_duplicate_groups": 56850
  },
  "window_category_partition": {
    "byte_identical_rows": 38,
    "conflicting_rows": 0,
    "json_semantically_identical_rows": 0,
    "malformed": 0
  }
}
```

## Policy

- JSON semantic identity means exact canonical parsed JSON equality only; no language model or quality claim.
- Byte identity includes the physical LF/CRLF terminator or its absence; row_sha256 excludes exactly one terminator.
- All fields, including original character offsets and source provenance, participate in full-record equality.
- Only byte-identical groups are potential deterministic row-dedup proposals; no deletion or survivor is authorized.
- Every other group requires provenance investigation, never first/last precedence or guessed resolution.
- Original work scopes and blockers remain unchanged; B001 namespace/metadata mapping is outside this audit.
- Malformed rows without an unambiguous parsed ID are reported separately and never assigned a guessed group.
- Raw bytes are retained in memory for duplicate groups only, never emitted as source prose or a new snapshot.

Exact row/group bindings are in affected_windows.jsonl and groups.jsonl. All original multiplicities are preserved.
