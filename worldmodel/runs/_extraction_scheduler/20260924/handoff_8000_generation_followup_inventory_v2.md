# Generation Follow-Up: Inventory V2 Handoff

## Current Result

The OFFLINE inventory is complete. It grants no model dispatch permission and
contains no runnable request batch. Do not turn its queues into an automatic
983-call run or restart whole books to make completion reports green.

Root: `D:\aitrpg\世界模型\worldmodel`.

Read relative paths:

```text
runs/_extraction_scheduler/20260924/generation_followup_inventory_v2/manifest.json
runs/_extraction_scheduler/20260924/generation_followup_inventory_v2/report.md
runs/_extraction_scheduler/20260924/generation_followup_inventory_v2/report.json
runs/_extraction_scheduler/20260924/generation_followup_inventory_v2/regeneration_windows_8000.jsonl
runs/_extraction_scheduler/20260924/generation_followup_inventory_v2/offline_disposition_windows.jsonl
runs/_extraction_scheduler/20260924/generation_followup_inventory_v2/deferred_windows.jsonl
runs/_extraction_scheduler/20260924/generation_followup_inventory_v2/entry_accounting.jsonl
```

Externally pin the V2 output manifest:

```text
b7aecb1f7009cb6353356fdff0de7ba5575965179f6bd4abb0652544f24c55da
```

This is a diagnostic successor to the sealed V1 inventory. V1 tool, input and
output records remain unchanged; supersession is not candidate promotion or
an effective-verifier decision.

## Accounting

```text
Original queue rows: 3870
Unique rejected cards: 3865
Bad generator windows: 5
Unique affected windows: 3216
Works represented: 125

Source-resolved regeneration candidate windows: 983 (41 works)
Offline disposition/no-generation windows: 0
Deferred source/policy windows: 2233 (84 works)
```

The 983 candidate windows cover 1176 rejected cards and one bad-JSON window.
The deferred windows cover 2689 rejected cards and four bad-JSON windows.
One future generation request per candidate window gives a CONDITIONAL upper
bound of 983 for this currently resolved subset, not actual requests and not
a final total after resolving deferred sources.

## Source Blockers

All 2233 deferred windows have a sentence/work binding mismatch under the
current strict validator. Thirty-eight ALSO have ambiguous duplicate sentence
IDs, all within `网游之射破苍穹`. Missing referenced sentence IDs: zero.

Small independent samples favor a local `B001` namespace explanation rather
than proven cross-book substitution. This does not establish the cause for all
84 works. Never replace `B001` with a title globally or silently deduplicate the
historically pinned sentence files.

Deferred work requires a separate exact source-identity/namespace binding
decision with pinned per-work evidence. If source correction is approved, make
a NEW derived source snapshot and binding/lineage record, never edit the old
file or reuse its hash. Then recompute a NEW inventory. Do not use Qwen to guess
source identity, missing relationships, or duplicate-ID precedence.

## Next Bounded Preparation Only

1. Verify the inventory manifest pin and reproduce its outputs offline.
2. Select at most five explicit windows from `regeneration_windows_8000.jsonl`,
   avoiding repeated work already covered by a sealed experimental attempt
   unless a separately documented comparison genuinely needs it. Existing
   literal-regression results do not silently supersede original snapshot rows.
3. Use each selected row's exact original full coverage/source pins. Do not
   infer source paths from the work title or use a selected-row file as the full
   original snapshot. Preserve original accepted siblings and rejected cards.
4. Prepare a separate literal-v2 experiment decision/package following:

```text
runs/_extraction_scheduler/20260924/production_round1_audit_20261015/LITERAL_EXPERIMENT_HANDOFF.md
tools/prepare_literal_experiment_v2.py
```

The versioned V2 experiment adapter handles observed vLLM metadata fields; it
does not relax model, choice, stop, literal or source validation. Pin its current
bytes and the exact prompt/core/config. Do not feed literal-v2 output to the
production numeric-span runner without an explicit integration.

Return the selected identities, decision/package paths and hashes, planned
request count and all preparation blockers. STOP before any health/completion
request. New Qwen calls require the inference owner's explicit bounded budget;
no previous smoke budget is reset or inherited by preparing this package.

## Preserve Boundaries

```text
dispatch_authorized=false
effective_status=unknown
candidate_not_confirmed
no_transfer
no_runtime_effect
quality_certified=false
```

Do not claim any source proposition is now semantically true or independently
verified. Good-sibling counts describe structural checks/original flags only.
Keep 8001 semantic verification pending when unavailable. Keep bulk semantic
discovery and original/reverify disagreement adjudication assigned to Luna.
