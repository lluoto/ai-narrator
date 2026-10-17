#!/usr/bin/env python3
"""Offline V2 shape diagnostics. V1 code, tests and sealed products stay unchanged."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "runs/_extraction_scheduler/20260924"
OUT = BASE / "verifier_followup_inventory_v2"
V1_PATH = ROOT / "tools/build_verifier_followup_inventory.py"
V1_CODE_PIN = "19e25d96268fae63c52c503a12da0a87f5eb06785e3cf743a7b608a4c499f66d"
V1_TEST_PIN = "ef9432284f7ca962bd42b13960da66b8f692bd1b1072f237732925361b55b5de"
V1_MANIFEST = BASE / "verifier_followup_inventory_v1/manifest.json"
V1_MANIFEST_PIN = "ca2ae8c3f57612293717f10dd50c3f665a206b5afc2251099d38f481401bb8f0"


def load_v1():
    data = V1_PATH.read_bytes()
    if hashlib.sha256(data).hexdigest() != V1_CODE_PIN:
        raise ValueError("v1_code_hash_mismatch")
    spec = importlib.util.spec_from_file_location("verifier_inventory_v1_pinned_for_v2", V1_PATH)
    module = importlib.util.module_from_spec(spec)
    exec(compile(data, str(V1_PATH), "exec"), module.__dict__)
    return module


V1 = load_v1()


class Builder(V1.Builder):
    def verify_attempt(self, entry, grow, card, job, refs):
        V1.require(isinstance(entry, dict), "attempt_entry_not_object")
        row, _, _ = self.locator(entry["attempt_artifact"], "card_id", entry["card_id"], verifier=True)
        V1.require(isinstance(row, dict), "attempt_owner_not_object")
        verifier = row.get("verifier")
        V1.require(isinstance(verifier, dict), "attempt_verifier_not_object")
        V1.require(isinstance(verifier.get("call_meta"), dict), "attempt_call_meta_not_object")
        # Reuse all V1 identity, status, candidate and job checks. Locator reads are
        # cached; the second lookup rechecks metadata without reopening the file.
        return super().verify_attempt(entry, grow, card, job, refs)


# This private, hash-checked module instance alone uses the subclass. No source,
# runner, compiler, helper or imported V1 test module is patched or rewritten.
V1.Builder = Builder


def __getattr__(name):
    return getattr(V1, name)


SHAPE_POLICY = {
    "checked_containers": ["attempt_entry", "attempt_owner", "verifier", "verifier_call_meta"],
    "required_shape": "dictionary_before_field_access",
    "malformed_origin": "deferred_record_integrity",
    "malformed_counterpart": "deferred_record_integrity_with_unverified_advisory_status_retained",
    "missing_null_or_empty_nonobject_metadata": "rejected_not_coerced_to_dictionary",
    "attribute_error_caught": False,
    "model_calls": 0, "network_calls": 0,
}


def build():
    inputs = V1.Inputs(ROOT)
    sealed = V1.strict(inputs.read(V1_MANIFEST, V1_MANIFEST_PIN))
    inputs.read(V1_PATH, V1_CODE_PIN)
    v1_tests = ROOT / "tests/test_verifier_followup_inventory.py"
    inputs.read(v1_tests, V1_TEST_PIN)
    V1.require(sealed["builder"]["sha256"] == V1_CODE_PIN
               and sealed["tests"]["sha256"] == V1_TEST_PIN, "v1_manifest_code_pins_disagree")
    previous = {}
    for name, pin in sealed["outputs"].items():
        V1.require(Path(name).name == name and name not in (".", "..", "manifest.json"), "unsafe_v1_output_name")
        data = inputs.read(V1_MANIFEST.with_name(name), pin["sha256"])
        V1.require(len(data) == pin["bytes"], "v1_output_size_mismatch")
        previous[name] = data
    V1.require({p.name for p in V1_MANIFEST.parent.iterdir()} == set(previous) | {"manifest.json"}, "v1_output_set_mismatch")
    # The pinned V1 build invokes only our narrowly overridden validator method.
    products, report, guards = V1.build()
    prior_report = V1.strict(previous["report.json"])
    comparison_names = (*V1.FILES, "attempt_accounting.jsonl")
    reconciliation = {
        "v1_candidate_and_accounting_bytes_preserved": all(products[n] == previous[n] for n in comparison_names),
        "totals_preserved": report["totals"] == prior_report["totals"],
        "partitions_preserved": report["partitions"] == prior_report["partitions"],
        "historical_advisory_overlap_preserved": report["reverify_overlap"] == prior_report["reverify_overlap"],
        "v1_sealed_output_hashes_verified": True,
    }
    V1.require(all(reconciliation.values()), "actual_snapshot_v1_reconciliation_failed")
    supersession = {
        "scope": "diagnostics_only",
        "v1_manifest": inputs.pin(V1_MANIFEST),
        "v1_builder": inputs.pin(V1_PATH),
        "v1_tests": inputs.pin(v1_tests),
        "v1_preserved_byte_reproducible": True,
        "effective_verdict_selected": False,
        "source_or_semantic_status_changed": False,
    }
    report.update(schema="verifier_followup_inventory.v2", supersession=supersession,
                  attempt_shape_policy=SHAPE_POLICY, v1_reconciliation=reconciliation)
    products["report.json"] = V1.encoded(report)
    products["report.md"] = (
        "# Offline Verifier Follow-up Inventory V2\n\n"
        "Diagnostics-only successor; V1 remains sealed and byte reproducible. Zero model/network calls.\n"
        "Malformed origins or counterparts defer the candidate to deferred_record_integrity. "
        "Counterpart statuses remain unverified advisory evidence, never silent acceptance. "
        "No AttributeError is swallowed. No requests, prompts, new verdicts, dispatch or certification.\n\n"
        "## Supersession\n\n```json\n" + V1.encoded(supersession).decode() + "```\n\n"
        "## Totals\n\n```json\n" + V1.encoded(report["totals"]).decode() + "```\n\n"
        "## Partitions\n\n```json\n" + V1.encoded(report["partitions"]).decode() + "```\n\n"
        "## V1 Reconciliation\n\n```json\n" + V1.encoded(reconciliation).decode() + "```\n\n"
        + report["call_bound_policy"] + "\n").encode("ascii")
    manifest = V1.strict(products["manifest.json"])
    inputs.read(Path(__file__))
    tests = ROOT / "tests/test_verifier_followup_inventory_v2.py"
    inputs.read(tests)
    manifest.update(schema="verifier_followup_inventory.v2.manifest",
                    builder=inputs.pin(Path(__file__)), tests=inputs.pin(tests),
                    supersession=supersession, attempt_shape_policy=SHAPE_POLICY,
                    v1_reconciliation=reconciliation,
                    code_loading="pinned_private_v1_module_with_verify_attempt_subclass_only_no_source_rewriting")
    observed = {}
    for guard in (*guards, inputs):
        for path, pin in guard.observed.items():
            V1.require(path not in observed or observed[path] == pin, "overlapping_input_pin_disagrees")
            observed[path] = pin
    manifest["actual_read_inputs"] = sorted(observed.values(), key=lambda r: r["path"])
    manifest["outputs"] = {name: {"sha256": V1.digest(data), "bytes": len(data)}
                           for name, data in sorted(products.items()) if name != "manifest.json"}
    for guard in (*guards, inputs):
        guard.recheck()
    products["manifest.json"] = V1.encoded(manifest)
    return products, report, (*guards, inputs)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--materialize", choices=("newabsent",))
    mode.add_argument("--check", action="store_true")
    parser.add_argument("--manifest-sha256")
    args = parser.parse_args(argv)
    try:
        V1.require(bool(args.manifest_sha256) == args.check, "external_manifest_pin_required_only_for_check")
        if args.materialize:
            V1.require(not OUT.exists() and OUT.parent.is_dir(), "new_absent_output_directory_required")
        if args.check:
            V1.require(re.fullmatch(r"[0-9a-f]{64}", args.manifest_sha256 or "")
                       and V1.V2.file_hash(OUT / "manifest.json") == args.manifest_sha256, "output_manifest_hash_mismatch")
        products, report, guards = build()
        if args.check:
            V1.V2.check_outputs(OUT, args.manifest_sha256, products)
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
                    V1.require((OUT / name).read_bytes() == data, "output_write_mismatch")
            with (OUT / "manifest.json").open("xb") as handle:
                handle.write(products["manifest.json"])
        print(json.dumps({"mode": "check" if args.check else "materialize" if args.materialize else "dry_run",
                          "manifest_sha256": V1.digest(products["manifest.json"]), "totals": report["totals"],
                          "partitions": report["partitions"], "reverify_overlap": report["reverify_overlap"],
                          "v1_reconciliation": report.get("v1_reconciliation", {}),
                          "model_calls": 0, "network_calls": 0}, sort_keys=True))
        return 0
    except (ValueError, KeyError, TypeError, OSError) as error:
        print("FAIL: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
