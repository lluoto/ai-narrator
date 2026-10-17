# Generation Follow-up Inventory V3

Offline only. No dispatch authorized.

## Partitions

```json
{
  "deferred_source_or_policy": {
    "already_good_siblings": 53,
    "bad_window_entries": 0,
    "input_rows": 54,
    "max_future_8000_calls_if_explicitly_authorized": 0,
    "total_original_window_cards": 107,
    "unique_rejected_cards": 54,
    "windows": 47,
    "windows_with_good_siblings": 37,
    "windows_with_unresolved_original_card_count": 0,
    "works": 1
  },
  "offline_disposition_no_generation": {
    "already_good_siblings": 0,
    "bad_window_entries": 0,
    "input_rows": 0,
    "max_future_8000_calls_if_explicitly_authorized": 0,
    "total_original_window_cards": 0,
    "unique_rejected_cards": 0,
    "windows": 0,
    "windows_with_good_siblings": 0,
    "windows_with_unresolved_original_card_count": 0,
    "works": 0
  },
  "regeneration_candidate_8000": {
    "already_good_siblings": 3816,
    "bad_window_entries": 5,
    "input_rows": 3816,
    "max_future_8000_calls_if_explicitly_authorized": 3169,
    "total_original_window_cards": 7627,
    "unique_rejected_cards": 3811,
    "windows": 3169,
    "windows_with_good_siblings": 2696,
    "windows_with_unresolved_original_card_count": 0,
    "works": 124
  }
}
```

## Reconciliation

```json
{
  "all_entries_match_window_partition": true,
  "all_v2_raw_windows_reproduced": true,
  "candidate_increment": 2186,
  "card_and_entry_partition_sums_match": true,
  "exact_bindings_applied": 83,
  "original_candidate_baseline_preserved": 983,
  "original_card_metadata_preserved": true,
  "original_lineage_and_group_keys_preserved": true,
  "remaining_deferred_by_work": {
    "网游之射破苍穹": 47
  },
  "successful_projection_windows": 2186,
  "transitions": {
    "deferred_source_or_policy -> deferred_source_or_policy": 47,
    "deferred_source_or_policy -> regeneration_candidate_8000": 2186,
    "regeneration_candidate_8000 -> regeneration_candidate_8000": 983
  }
}
```
