#!/usr/bin/env python3
"""Binding-aware offline inventory. No runner import, request body, or dispatch.

Reuse the pinned v2 raw validator, then narrowly reconsider its identity veto.
No core function is wrapped, replaced, or rewritten.
"""
from __future__ import annotations

import argparse
from collections import Counter
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "runs/_extraction_scheduler/20260924"
OUT = BASE / "generation_followup_inventory_v3"
V2_MANIFEST = BASE / "generation_followup_inventory_v2/manifest.json"
V2_PIN = "b7aecb1f7009cb6353356fdff0de7ba5575965179f6bd4abb0652544f24c55da"
V2_CODE_PIN = "7a0090ce93af626cf026956350099c1a8a5362699a1827ce66273d48d6dcbddb"
IDENTITY_MANIFEST = BASE / "source_identity_bindings_approved_v1/manifest.json"
IDENTITY_PIN = "69edf31249b31bd6fbc05768169b5eda3a15dc8ef547bc1bcb34bd7fd3e401d2"
HELPER_PIN = "966da73c4608de70de09aee419cf2b220dbd8bbb346c222a379da39d65508cef"
DEDUP_PIN = "45dfc18bc3f91dd2bbecab72da00f3e3cdd70f6050dd62b17d580d306b26eac8"


def load_module(name, path, expected):
    # Hash before execution; these two offline modules have no runner imports.
    import hashlib
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError("referenced_code_hash_mismatch:" + name)
    module = importlib.util.module_from_spec(importlib.util.spec_from_file_location(name, path))
    exec(compile(data, str(path), "exec"), module.__dict__)
    return module


V2 = load_module("inventory_v2_pinned", ROOT / "tools/build_generation_followup_inventory_v2.py", V2_CODE_PIN)
IDENTITY = load_module("approved_identity_pinned", ROOT / "tools/approved_source_identity.py", HELPER_PIN)
PROJECTION_POLICY = {
    "scope": "exact_named_work_original_full_file_sha256_raw_local_work_id_only",
    "projection": "ephemeral_selected_record_copy_work_id_only_after_exact_approval_and_raw_checks",
    "originals_mutated": False, "semantic_truth_proven": False, "global_B001_alias": False,
    "derived_hash_inherits_approval": False, "core_build_window_unchanged": True,
}


class Builder(V2.Builder):
    def __init__(self, root, audit_dir, pins, prior, *, bindings, identity_refs):
        super().__init__(root, audit_dir, pins, prior)
        self.bindings = bindings
        self.identity_refs = identity_refs
        self.raw_baseline = {}

    def book(self, work, entries, core, audit_manifest):
        start, entry_start = len(self.windows), len(self.entries)
        # All original job/gen/coverage/source and queue/card matching runs on raw values.
        super().book(work, entries, core, audit_manifest)
        for row in self.windows[start:]:
            self.raw_baseline[row["group_id"]] = V2.canonical(row)
            row["v2_baseline"] = {k: row[k] for k in ("decision", "source_blockers", "reason_codes")}
            row["source_identity_binding"] = []
            row["source_identity_projection"] = {**PROJECTION_POLICY, "attempted": False, "performed": False}
            if "sentence_work_mismatch" not in row["source_blockers"]:
                continue
            hard = set(row["source_blockers"])
            refs = row["artifacts"]
            bound, approved_all = {}, True
            source_ref = refs["sentences"]
            sources = self.inputs.rows(source_ref["path"], source_ref["sha256"], "sentence_id")
            for loc in row["sentence_rows"]:
                matches = sources.get(loc["sentence_id"], [])
                source = next(s for s, sloc in matches if sloc["line"] == loc["line"])
                if source.get("work_id") in (None, work):
                    bound[loc["sentence_id"]] = source
                    continue
                try:
                    V2.require(loc["file_sha256"] == source_ref["sha256"] ==
                               row["original_execution_input_pins"]["sentences.jsonl"],
                               "original_source_pin_disagrees")
                    IDENTITY.validate_local_identity(
                        self.bindings, work_id=work, source_sha256=source_ref["sha256"],
                        local_work_id=source.get("work_id"))
                    key = (work, source_ref["sha256"], source["work_id"])
                    record = self.bindings[key]
                    for label in ("job", "generator", "coverage"):
                        V2.require(all(record["artifacts"][label][k] == refs[label][k]
                                       for k in ("path", "sha256")), "approval_artifact_disagrees")
                    receipt = {
                        "key": dict(record["key"]), "original_work_id": source["work_id"],
                        "named_scope": work, "sentence_line": loc["line"],
                        "sentence_row_sha256": loc["row_sha256"],
                        "sidecar_manifest": self.identity_refs["manifest"],
                        "authorization": self.identity_refs["authorization"],
                        "approved_records": self.identity_refs["records"],
                    }
                    row["source_identity_binding"].append(receipt)
                    # Only work_id differs. Text, IDs, chapter, offsets and provenance survive intact.
                    bound[loc["sentence_id"]] = {**source, "work_id": work}
                except (ValueError, KeyError, TypeError):
                    approved_all = False
            if not approved_all:
                continue
            hard.discard("sentence_work_mismatch")
            window = None
            if not hard:
                try:
                    cov_ref = refs["coverage"]
                    cov = self.inputs.rows(cov_ref["path"], cov_ref["sha256"], "window_id")[row["window_id"]][0][0]
                    row["source_identity_projection"]["attempted"] = True
                    window = core["build_window"](cov, bound)
                    row["source_identity_projection"]["performed"] = True
                except (ValueError, KeyError, TypeError) as error:
                    hard.add(self.reason(error))
            needs, observations = set(row["current_need_families"]), set(row["observations"])
            if window is not None:
                gen_ref = refs["generator"]
                grow = self.inputs.rows(gen_ref["path"], gen_ref["sha256"], "window_id")[row["window_id"]][0][0]
                for card, meta in zip(grow.get("cards") or [], row["original_cards"]):
                    normalized, errors = core["validate_card"](card.get("generator_card"), window)
                    meta["current_card_error_families"] = V2.families(errors)
                    meta["current_card_validation_performed"] = True
                    meta["normalization_mismatch"] = normalized != card.get("normalized_card")
                    if card.get("accepted_for_verification") is not True:
                        needs.update(V2.families(errors))
                        if not errors:
                            observations.add("rejected_card_now_structurally_valid")
                    if meta["normalization_mismatch"]:
                        observations.add("normalization_mismatch_preserved")
            decision = V2.PARTITIONS[2] if hard else V2.PARTITIONS[0] if needs else V2.PARTITIONS[1]
            row.update(source_blockers=sorted(hard), current_need_families=sorted(needs),
                       observations=sorted(observations), decision=decision,
                       reason_codes=sorted(hard or needs or {"structurally_valid_or_bookkeeping_only"}),
                       max_future_8000_calls_if_explicitly_authorized=int(decision == V2.PARTITIONS[0]))
        by_group = {r["group_id"]: r for r in self.windows[start:]}
        for entry in self.entries[entry_start:]:
            row = by_group[entry["group_id"]]
            row["source_work_binding_policy"] = "Raw named/null v2 policy, or exact approved original-file tuple with explicit ephemeral projection."
            row["later_requirement"] = "Approved binding-aware prep path, explicit generation budget approval, and independent card verifier packaging. No status promotion."
            entry.update(decision=row["decision"], reason_codes=row["reason_codes"])
            index = entry["generator_locator"].get("card_index")
            if type(index) is int and 0 <= index < len(row["original_cards"]):
                entry["current_card_error_families"] = row["original_cards"][index]["current_card_error_families"]


def reconcile(builder, previous):
    V2.require(set(previous) == set(builder.raw_baseline), "v2_group_partition_disagrees")
    for group, row in previous.items():
        V2.require(V2.canonical(row) == builder.raw_baseline[group], "v2_raw_baseline_not_reproduced")
    transitions = Counter()
    preserved, increments = 0, 0
    immutable = ("grouping_key", "artifacts", "original_execution_input_pins", "originating_entries",
                 "sentence_rows", "sentence_ids", "generator_rows", "coverage_row", "raw_response_sha256",
                 "audited_sentence_aliases", "chapter_id", "work_id", "cohort", "already_good_sibling_count",
                 "rejected_sibling_count", "total_original_window_cards", "unique_rejected_cards", "input_rows")
    for row in builder.windows:
        old = previous[row["group_id"]]
        V2.require(all(old[k] == row[k] for k in immutable), "original_lineage_changed")
        current_fields = {"current_card_error_families", "current_card_validation_performed", "normalization_mismatch"}
        V2.require([{k: v for k, v in card.items() if k not in current_fields} for card in old["original_cards"]] ==
                   [{k: v for k, v in card.items() if k not in current_fields} for card in row["original_cards"]],
                   "original_card_metadata_changed")
        if old["decision"] == V2.PARTITIONS[0]:
            V2.require(row["decision"] == old["decision"], "original_candidate_not_preserved")
            preserved += 1
        elif row["decision"] != old["decision"]:
            V2.require(old["source_blockers"] == ["sentence_work_mismatch"]
                       and row["source_identity_projection"]["performed"], "nonidentity_release")
            increments += int(row["decision"] == V2.PARTITIONS[0])
        transitions[old["decision"] + " -> " + row["decision"]] += 1
    groups = {r["group_id"]: r for r in builder.windows}
    for entry in builder.entries:
        row = groups[entry["group_id"]]
        V2.require(entry["decision"] == row["decision"] and entry["reason_codes"] == row["reason_codes"],
                   "entry_window_partition_disagrees")
    V2.require(Counter(e["group_id"] for e in builder.entries) ==
               Counter({r["group_id"]: r["input_rows"] for r in builder.windows}), "entry_group_cardinality_disagrees")
    return {"original_candidate_baseline_preserved": preserved, "candidate_increment": increments,
            "transitions": dict(sorted(transitions.items())), "original_lineage_and_group_keys_preserved": True,
            "all_v2_raw_windows_reproduced": True, "original_card_metadata_preserved": True,
            "all_entries_match_window_partition": True}


def build():
    inputs = V2.Inputs(ROOT)
    v2 = V2.strict(inputs.read(V2_MANIFEST, V2_PIN))
    V2.require(v2["builder"]["sha256"] == V2_CODE_PIN, "v2_builder_pin_disagrees")
    inputs.read(**V2.Builder.read_args(v2["builder"]))
    inputs.read(**V2.Builder.read_args(v2["current_core"]))
    helper = {"path": (ROOT / "tools/approved_source_identity.py").as_posix(), "sha256": HELPER_PIN}
    inputs.read(**V2.Builder.read_args(helper))
    bindings = IDENTITY.load_approved_bindings(IDENTITY_MANIFEST, IDENTITY_PIN)
    identity_manifest = V2.strict(inputs.read(IDENTITY_MANIFEST, IDENTITY_PIN))
    identity_refs = {"manifest": inputs.pin(IDENTITY_MANIFEST)}
    for label, name in (("authorization", "authorization.json"), ("records", "approved_bindings.jsonl")):
        path = IDENTITY_MANIFEST.with_name(name)
        inputs.read(path, identity_manifest["outputs"][name]["sha256"])
        identity_refs[label] = inputs.pin(path)
    previous = {}
    for name, pin in v2["outputs"].items():
        data = inputs.read(V2_MANIFEST.with_name(name), pin["sha256"])
        if name in V2.QUEUE_FILES:
            for raw in data.splitlines():
                row = V2.strict(raw)
                V2.require(row["group_id"] not in previous, "duplicate_v2_group")
                previous[row["group_id"]] = row
    builder = Builder(ROOT, v2["audit_dir"], v2["audit_pins"], v2["prior_v1"],
                      bindings=bindings, identity_refs=identity_refs)
    products, report = builder.compile()
    reconciliation = reconcile(builder, previous)
    V2.require((len(builder.entries), len(builder.windows)) == (3870, 3216), "snapshot_totals_disagree")
    lineage = {}
    for row in builder.windows:
        item = lineage.setdefault(row["work_id"], {"original_source_hashes": set(), "exact_approved_keys": set(),
                                                  "binding_windows": 0, "projected_windows": 0})
        item["original_source_hashes"].add(row["grouping_key"][3])
        item["binding_windows"] += bool(row["source_identity_binding"])
        item["projected_windows"] += row["source_identity_projection"]["performed"]
        for receipt in row["source_identity_binding"]:
            item["exact_approved_keys"].add(tuple(receipt["key"][k] for k in IDENTITY.KEY_FIELDS))
    for item in lineage.values():
        item["original_source_hashes"] = sorted(item["original_source_hashes"], key=str)
        item["exact_approved_keys"] = [dict(zip(IDENTITY.KEY_FIELDS, key)) for key in sorted(item["exact_approved_keys"])]
    deferred = [r for r in builder.windows if r["decision"] == V2.PARTITIONS[2]]
    reconciliation["remaining_deferred_by_work"] = dict(sorted(Counter(r["work_id"] for r in deferred).items()))
    count_fields = ("windows", "input_rows", "unique_rejected_cards", "bad_window_entries",
                    "already_good_siblings", "total_original_window_cards")
    V2.require(all(sum(p[k] for p in report["partitions"].values()) == report["totals"][k]
                   for k in count_fields), "card_or_entry_partition_sum_disagrees")
    reconciliation["card_and_entry_partition_sums_match"] = True
    reconciliation["exact_bindings_applied"] = len({tuple(receipt["key"][k] for k in IDENTITY.KEY_FIELDS)
        for row in builder.windows for receipt in row["source_identity_binding"]})
    reconciliation["successful_projection_windows"] = sum(r["source_identity_projection"]["performed"]
                                                           for r in builder.windows)
    report.update(schema_version=3, reconciliation=reconciliation, source_identity_projection=PROJECTION_POLICY,
                  approved_identity=identity_refs, approved_binding_count=len(bindings), source_lineage_by_work=lineage)
    report["supersession"] = {"scope": "V3 binding-aware offline classification only; v1/v2 remain sealed.",
                              "v2_manifest": inputs.pin(V2_MANIFEST), "v2_builder": v2["builder"]}
    report["policy"] += ["Identity approval grants no Qwen budget, quality certification, or manifest promotion.",
                         "Generic literal preparation still rejects B001; a separately approved binding-aware prep path is required."]
    manifest = V2.strict(products["manifest.json"])
    manifest.update(schema_version=3, builder={"path": Path(__file__).as_posix(),
                                              "sha256": V2.digest(inputs.read(Path(__file__)))},
                    referenced_v2_builder=v2["builder"], approved_helper=helper,
                    v2_inventory=inputs.pin(V2_MANIFEST), approved_identity=identity_refs,
                    exact_approved_keys=[dict(r["key"]) for r in bindings.values()],
                    approved_original_sources=[dict(r["source"]) for r in bindings.values()],
                    source_identity_projection=PROJECTION_POLICY, supersession=report["supersession"],
                    controlled_code_change="New v3 offline reconsideration after unchanged pinned v2 raw validation; no AST rewrite or global work-check bypass.")
    # Optional observation is not opened as a sentence source and is never used for classification.
    dedup_path = BASE / "source_deduplication_approved_v1" / IDENTITY.EXCLUDED_WORK / "manifest.json"
    dedup_data = inputs.read(dedup_path, DEDUP_PIN)
    dedup = V2.strict(dedup_data)
    note = {"manifest": inputs.pin(dedup_path), "use": "observed_separate_snapshot_only_not_original_generation_input",
            "original_sha256": dedup["counts"]["original_sha256"],
            "derived_sha256": dedup["counts"]["derived_sha256"], "approval_inherited": False}
    report["dedup_snapshot_observation"] = note
    manifest["dedup_snapshot_observation"] = note
    products["report.json"] = V2.encoded(report)
    products["report.md"] = ("# Generation Follow-up Inventory V3\n\nOffline only. No dispatch authorized.\n\n"
                              "## Partitions\n\n```json\n" + V2.encoded(report["partitions"]).decode() +
                              "```\n\n## Reconciliation\n\n```json\n" + V2.encoded(reconciliation).decode() + "```\n").encode("utf-8")
    products["README.md"] = (
        "# Binding-aware Follow-up V3\n\n"
        "Offline inventory only; zero API/model/network calls, no requests or production dispatch. "
        "V1/V2, current core, sources, audits, config, prompts and production are unchanged.\n\n"
        "Pinned V2 validates all original raw job/gen/coverage/source/queue/card provenance first. "
        "Only its sentence_work_mismatch veto can be reconsidered using the approved helper's exact "
        "(named work, full original sentence-file SHA256, raw local work ID) check. Receipts pin the "
        "sidecar manifest, authorization and approved records. Original sentence rows and group keys remain intact. "
        "Only a selected ephemeral copy's work_id is projected before unchanged core build_window/card validation; "
        "text, IDs, chapters, offsets and provenance are not changed. This is not semantic truth or human review. "
        "All other blockers still defer. No global B001 alias or inherited derived-file approval exists.\n\n"
        "The separately observed dedup manifest never replaces the original generation source. "
        "The excluded work's original duplicate/identity blockers remain deferred.\n\n"
        "Consumers need a separately approved binding-aware preparation path. Current generic literal prep "
        "still rejects B001 and is intentionally unchanged. Identity approval grants no Qwen budget, "
        "quality certification, publication, manifest promotion, or dispatch authority. The candidate call bound "
        "is conditional, not an approved/final Qwen request count; independent verifier packaging is still required.\n\n"
        "Dry run: `python -B tools/build_generation_followup_inventory_v3.py`\n\n"
        "Materialize once: add `--materialize newabsent`. Read-only reproduce/check: "
        "`--check --manifest-sha256 <external full SHA256>`. Manifest is written last.\n"
    ).encode("ascii")
    for path in set(builder.inputs.observed) & set(inputs.observed):
        V2.require(builder.inputs.observed[path] == inputs.observed[path], "overlapping_input_pin_disagrees")
    manifest["actual_read_inputs"] = sorted(
        {**builder.inputs.observed, **inputs.observed}.values(), key=lambda r: r["path"])
    manifest["outputs"] = {name: {"sha256": V2.digest(data), "bytes": len(data)}
                           for name, data in sorted(products.items()) if name != "manifest.json"}
    products["manifest.json"] = V2.encoded(manifest)
    inputs.recheck()
    builder.inputs.recheck()
    return products, report, (inputs, builder.inputs)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--materialize", choices=("newabsent",))
    mode.add_argument("--check", action="store_true")
    parser.add_argument("--manifest-sha256")
    args = parser.parse_args(argv)
    try:
        V2.require(bool(args.manifest_sha256) == args.check, "external_manifest_pin_required_only_for_check")
        if args.materialize:
            V2.require(not OUT.exists() and OUT.parent.is_dir(), "new_absent_output_directory_required")
        if args.check:
            V2.require(V2.file_hash(OUT / "manifest.json") == args.manifest_sha256, "output_manifest_hash_mismatch")
        products, report, guards = build()
        if args.check:
            V2.check_outputs(OUT, args.manifest_sha256, products)
        elif args.materialize:
            OUT.mkdir()
            for name, data in products.items():
                if name != "manifest.json":
                    with (OUT / name).open("xb") as handle:
                        handle.write(data)
            for guard in guards:
                guard.recheck()
            for name, data in products.items():
                if name != "manifest.json":
                    V2.require((OUT / name).read_bytes() == data, "output_write_mismatch")
            with (OUT / "manifest.json").open("xb") as handle:
                handle.write(products["manifest.json"])
        print(json.dumps({"mode": "check" if args.check else "materialize" if args.materialize else "dry_run",
                          "manifest_sha256": V2.digest(products["manifest.json"]), "totals": report["totals"],
                          "partitions": report["partitions"], "reconciliation": report["reconciliation"],
                          "model_calls": 0, "network_calls": 0}, ensure_ascii=True, sort_keys=True))
        return 0
    except (ValueError, KeyError, TypeError, OSError) as error:
        print("FAIL: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
