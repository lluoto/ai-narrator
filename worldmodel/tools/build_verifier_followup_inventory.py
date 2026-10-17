#!/usr/bin/env python3
"""Pinned, offline, card-scoped follow-up inventory. Never prepares or dispatches requests."""
from __future__ import annotations

import argparse
import ast
from collections import Counter, defaultdict
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "runs/_extraction_scheduler/20260924"
AUDIT = BASE / "production_round1_audit_20261015"
OUT = BASE / "verifier_followup_inventory_v1"
PINS = {
    "manifest.json": "e03503a061bb3063506103c09e500b8bb7adb778493189dbff1a9b216c600fe2",
    "verifier_repair_queue.jsonl": "f1d6cb1d3c9310ac653edbb5a73a338900811f14ac4d1db825af91d6ac0ac911",
    "report.json": "ff9d242fc693c8c63496c8aa688ec7073e88fd3ca83efc11ebc7cd4edd110b12",
    "input_hashes.jsonl": "92cac88cb3133aa4a4fb28fa22ac11c7c3474da516097f3a96ed8e56eda96b72",
    "card_reconciliation.jsonl": "7de6531e80b607a8141f9bf3c872b596d1925253e13982acd36db8a6fa669100",
    "reverify_comparison.jsonl": "099781bbb3bbeee3dbb3e859ad215fb9dd9fbc1be19afa9ecd13d5351c9f8884",
}
V2_PIN = "7a0090ce93af626cf026956350099c1a8a5362699a1827ce66273d48d6dcbddb"
HELPER_PIN = "966da73c4608de70de09aee419cf2b220dbd8bbb346c222a379da39d65508cef"
IDENTITY_PIN = "69edf31249b31bd6fbc05768169b5eda3a15dc8ef547bc1bcb34bd7fd3e401d2"
CORE_PIN = "1813ee9a2504deea820962562691b2ff73e502bdd010dac92be1e8e2d62b72b6"
COMPILER_PIN = "e67f911c22cf02784768af962d8e104426780dd555b9338c3006658c45435773"
V3_PIN = "9186fb0fa64e5d38b5cc1c4528e545882cc898f72b39ef41986c086ea0715d36"
PARTITIONS = ("ready_for_verifier_preparation", "requires_generator_repair",
              "deferred_source_binding", "deferred_record_integrity")
FILES = ("verifier_ready_candidates.jsonl", "generator_repair_candidates.jsonl",
         "deferred_source_candidates.jsonl", "deferred_integrity_candidates.jsonl")
BOUNDARIES = {"dispatch_authorized": False, "model_calls": 0, "network_calls": 0,
              "quality_certified": False, "all_historical_candidates_certified": False,
              "publication_status": "candidate_not_confirmed", "transfer_policy": "no_transfer",
              "no_runtime_effect": True, "effective_status": "unknown",
              "messages_materialized": False, "prompt_bodies_materialized": False,
              "new_verdict_created": False, "originals_mutated": False}


def require(value, code):
    if not value:
        raise ValueError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    # Matches the card compiler, including ASCII escaping of stored candidates.
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"),
                      allow_nan=False).encode("utf-8")


def encoded(value):
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, indent=2, allow_nan=False) + "\n").encode()


def jsonl(rows):
    return b"".join(canonical(row) + b"\n" for row in rows)


def load_module(name, path, pin):
    data = path.read_bytes()
    require(digest(data) == pin, "referenced_code_hash_mismatch")
    module = importlib.util.module_from_spec(importlib.util.spec_from_file_location(name, path))
    exec(compile(data, str(path), "exec"), module.__dict__)
    return module


# Both modules are offline utilities. The runner and card compiler are never imported.
V2 = load_module("verifier_inventory_read_helpers", ROOT / "tools/build_generation_followup_inventory_v2.py", V2_PIN)
IDENTITY = load_module("verifier_inventory_identity", ROOT / "tools/approved_source_identity.py", HELPER_PIN)
strict = V2.strict


class Inputs(V2.Inputs):
    """One streamed subset per work/source, with stable metadata and final full rehash."""

    def __init__(self, root):
        super().__init__(root)
        self.stamps = {}

    @staticmethod
    def stamp(path):
        if not path.exists():
            return None
        info = path.stat()
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def before(self, path):
        path = self.path(str(path))
        stamp = self.stamp(path)
        key = path.as_posix()
        require(key not in self.stamps or self.stamps[key] == stamp, "input_metadata_changed")
        self.stamps[key] = stamp
        return path, stamp

    def after(self, path, stamp):
        require(self.stamp(path) == stamp, "input_metadata_changed")

    def read(self, path, expected=None):
        path, stamp = self.before(path)
        try:
            return super().read(path, expected)
        finally:
            self.after(path, stamp)

    def rows(self, path, expected, id_key, wanted=None):
        path, stamp = self.before(path)
        try:
            return super().rows(path, expected, id_key, wanted)
        finally:
            self.after(path, stamp)

    def recheck(self):
        for key, stamp in self.stamps.items():
            require(self.stamp(self.path(key)) == stamp, "final_metadata_changed")
        super().recheck()
        for key, stamp in self.stamps.items():
            require(self.stamp(self.path(key)) == stamp, "final_metadata_changed")


def compiler_rules(core_data, compiler_data):
    core = V2.load_core(core_data)
    core["sha256_text"] = lambda text: digest(text.encode("utf-8"))
    scope = {"C": SimpleNamespace(**core), "strict_json": strict, "require": require,
             "canonical_bytes": canonical, "Path": Path, "PurePosixPath": PurePosixPath,
             "SHA": re.compile(r"[0-9a-f]{64}\Z"), "re": re}
    names = {"envelope_errors", "job_manifest"}
    nodes = [node for node in ast.parse(compiler_data).body
             if isinstance(node, ast.FunctionDef) and node.name in names]
    require(len(nodes) == len(names) and all(not n.decorator_list for n in nodes), "compiler_slice_invalid")
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "pinned_card_compiler_pure_slice", "exec"), scope)
    return core, scope


# Closed diagnostic vocabulary; arguments and arbitrary field names are only hashed.
HISTORICAL_CODES = frozenset("""
cited_out_of_scope case_id_mismatch finish_reason verdict_block_malformed verdict_block_absent
verdict_block_duplicate verdict_block_trailing verdict_block_not_object empty_response
invalid_json not_an_object verifier_call_failed verifier_finish_not_stop bad_verifier_shape
bad_verdict bad_overall checks_required check_shape_invalid bad_check_shape field_missing
field_duplicate field_path_invalid missing_check duplicate_check bad_check_verdict
no_runtime_effect_missing normalized_card_required verifier_model_mismatch
unrecognized_error_code
""".split())


def codes(values):
    if not isinstance(values, list):
        return ["unrecognized_error_code"]
    return sorted({v.split(":", 1)[0] if isinstance(v, str) and v.split(":", 1)[0] in HISTORICAL_CODES
                   else "unrecognized_error_code" for v in values})


def status(value, allowed):
    return value if value in allowed else "unknown"


def attempt_status(entry):
    return {"attempt": status(entry.get("attempt"), ("original", "reverify_8001")),
            "attempt_artifact": entry.get("attempt_artifact"),
            "recorded_status": status(entry.get("recorded_status"), ("entailed", "insufficient", "contradicted", "unusable")),
            "audited_status": status(entry.get("audited_status"), ("entailed", "insufficient", "contradicted", "unusable")),
            "stored_verdict": status(entry.get("stored_verdict"), ("entailed", "insufficient", "contradicted", None)),
            "entailed_flag": entry.get("entailed_flag") if type(entry.get("entailed_flag")) is bool else None,
            "error_codes": codes(entry.get("error_codes", entry.get("independent_error_codes", []))),
            "stored_error_codes": codes(entry.get("stored_errors", [])),
            "stored_errors_sha256": digest(canonical(entry.get("stored_errors"))),
            "independent_error_codes": codes(entry.get("independent_error_codes", [])),
            "finish_reason": status(entry.get("finish_reason"), ("stop", "length", "error", None)),
            "http_status": entry.get("http_status") if type(entry.get("http_status")) is int else None}


def grouping_key(work, refs, window_id, card_id, candidate_hash):
    return [work, refs.get("generator", {}).get("sha256"), refs.get("coverage", {}).get("sha256"),
            refs.get("sentences", {}).get("sha256"), window_id, card_id, candidate_hash]


class Builder:
    def __init__(self, root, audit, pins, bindings, identity_refs, core, rules, *, expected_count=457):
        self.inputs = Inputs(root)
        self.audit, self.pins = Path(audit), pins
        self.bindings, self.identity_refs, self.core, self.rules = bindings, identity_refs, core, rules
        self.expected_count = expected_count
        self.inventory, self.reconciliation, self.comparisons = {}, defaultdict(list), defaultdict(list)
        self.groups, self.accounting = {}, []
        self.card_locations = {}

    def artifact(self, path, expected=None):
        path = self.inputs.path(str(path))
        relative = path.relative_to(self.inputs.root).as_posix()
        require(relative in self.inventory, "artifact_not_in_audit")
        pin = self.inventory[relative]["sha256"]
        require(expected is None or pin == expected, "audit_artifact_pin_conflict")
        return {"path": path.as_posix(), "sha256": pin}

    def provenance(self, work, label):
        rows = [r for r in self.report["historical_input_hash_checks"] if r["work"] == work and r["label"] == label]
        require(len(rows) == 1, "ambiguous_provenance")
        return rows[0]

    def locator(self, loc, id_key, identity, *, verifier=False):
        ref = self.artifact(loc["path"], loc["file_sha256"])
        rows = self.inputs.rows(ref["path"], ref["sha256"], id_key)
        if not verifier:
            require(len(rows.get(identity, [])) == 1, "generator_window_id_ambiguous")
            if ref["path"] not in self.card_locations:
                locations = defaultdict(list)
                for wid, records in rows.items():
                    for record, record_loc in records:
                        cards = record.get("cards")
                        for index, card in enumerate(cards if isinstance(cards, list) else []):
                            if isinstance(card, dict) and isinstance(card.get("card_id"), str):
                                locations[card["card_id"]].append((wid, record_loc["line"], index))
                self.card_locations[ref["path"]] = locations
        matches = [(row, actual) for row, actual in rows.get(identity, []) if actual["line"] == loc["line"]]
        require(len(matches) == 1, "locator_not_unique")
        row, actual = matches[0]
        require(actual["row_sha256"] == loc["row_sha256"], "row_hash_mismatch")
        container = row.get("verifier") if verifier else row
        require(isinstance(container, dict) and isinstance(container.get("raw_response"), str), "raw_response_missing")
        require(digest(container["raw_response"].encode("utf-8")) == loc["raw_response_sha256"], "raw_response_hash_mismatch")
        return row, actual, ref

    def verify_attempt(self, entry, grow, card, job, refs):
        row, actual, _ = self.locator(entry["attempt_artifact"], "card_id", entry["card_id"], verifier=True)
        work, wid, cid = entry["work"], entry["window_id"], entry["card_id"]
        require(row.get("work_id") == work and row.get("allowed_work_ids") == [work]
                and row.get("window_id") == wid and row.get("card_id") == cid
                and row.get("chapter_id") == grow.get("chapter_id"), "attempt_identity_mismatch")
        require(canonical(row.get("normalized_card")) == canonical(card.get("normalized_card"))
                and canonical(row.get("generator_card")) == canonical(card.get("generator_card")), "attempt_candidate_mismatch")
        ver = row["verifier"]
        meta = ver.get("call_meta") or {}
        require(ver.get("verdict") == entry.get("stored_verdict")
                and ver.get("errors", []) == entry.get("stored_errors")
                and row.get("entailed") == entry.get("entailed_flag")
                and meta.get("http_status") == entry.get("http_status")
                and meta.get("finish_reason") == entry.get("finish_reason"), "attempt_stored_status_mismatch")
        ajob_ref = self.artifact(str(self.inputs.path(entry["attempt_artifact"]["path"]).with_name("job_record.json")))
        ajob = strict(self.inputs.read(ajob_ref["path"], ajob_ref["sha256"]))
        require(isinstance(ajob, dict) and ajob.get("book") == work, "attempt_job_mismatch")
        if entry["attempt"] == "original":
            require(ajob_ref == refs["job"], "original_attempt_job_mismatch")
        else:
            require(entry["attempt"] == "reverify_8001", "unknown_attempt")
            for path_key, hash_key in (("source_generator_jsonl", "source_generator_jsonl_sha256"),
                                       ("generator_jsonl", "generator_jsonl_sha256")):
                if path_key in ajob or hash_key in ajob:
                    recorded = ajob[path_key]
                    # Persisted round-one jobs use scheduler-relative generator_jsonl paths.
                    if isinstance(recorded, str) and recorded.replace("\\", "/").startswith("proposition_canary_v1/"):
                        recorded = str(BASE / recorded)
                    require(self.inputs.path(recorded).as_posix() == refs["generator"]["path"]
                            and ajob[hash_key] == refs["generator"]["sha256"], "reverify_generator_binding_mismatch")
            require(any(k in ajob for k in ("source_generator_jsonl", "generator_jsonl")), "reverify_generator_binding_missing")
        if "input_artifact_hashes" in ajob:
            require(isinstance(ajob["input_artifact_hashes"], dict)
                    and all(ajob["input_artifact_hashes"].get(k) == job["input_artifact_hashes"].get(k)
                            for k in ("coverage_partition.jsonl", "sentences.jsonl")), "attempt_job_source_mismatch")
        return {**attempt_status(entry), "verified": True, "actual_row": actual, "job": ajob_ref,
                "attempt_job_has_source_pins": "input_artifact_hashes" in ajob,
                "source_binding_basis": "exact_original_generator_and_original_job_source_pins"}

    def source_window(self, work, grow, cov, sources, refs):
        require(work != IDENTITY.EXCLUDED_WORK, "excluded_source_blocked")
        require(cov.get("work_id") in (None, work), "coverage_work_mismatch")
        ids = cov.get("anchor_sentence_ids", []) + cov.get("attached_sentence_ids", [])
        require(isinstance(ids, list) and len(ids) == len(set(ids)), "source_ids_ambiguous")
        require(grow.get("chapter_id") == cov.get("chapter_id") and grow.get("sentence_ids") == ids,
                "generator_source_binding_mismatch")
        bound, locators, receipts = {}, [], []
        for sid in ids:
            matches = sources.get(sid, [])
            require(len(matches) == 1, "sentence_id_missing" if not matches else "sentence_id_ambiguous")
            source, loc = matches[0]
            locators.append({**loc, "sentence_id": sid, "original_work_id": source.get("work_id")})
            if source.get("work_id") not in (None, work):
                IDENTITY.validate_local_identity(self.bindings, work_id=work,
                    source_sha256=refs["sentences"]["sha256"], local_work_id=source.get("work_id"))
                key = (work, refs["sentences"]["sha256"], source["work_id"])
                record = self.bindings[key]
                require(all(all(record["artifacts"][label][k] == refs[label][k] for k in ("path", "sha256"))
                            for label in ("job", "generator", "coverage")), "approval_artifact_mismatch")
                receipts.append({"key": dict(record["key"]), "sentence_row": loc,
                                 "approvals": self.identity_refs, "projection": "ephemeral_work_id_only",
                                 "originals_mutated": False})
                source = {**source, "work_id": work}
            bound[sid] = source
        window = self.core["build_window"]({**cov, "work_id": work}, bound)
        return window, locators, receipts

    def candidate(self, work, entry, sources, coverage, source_refs, source_error):
        refs = dict(source_refs)
        integrity, source_errors, repairs = [], [], []
        grow, card, job, gloc = {}, {}, {}, None
        recs = self.reconciliation[(work, entry["card_id"])]
        # Join by the exact failed-attempt locator, not by a globally unique-looking ID.
        recs = [r for r in recs if any(a["attempt_artifact"] == entry["attempt_artifact"]
                                      for a in r.get("original", []) + r.get("reverify", []))]
        try:
            require(len(recs) == 1, "ambiguous_card_reconciliation")
            rec = recs[0]
            grow, gloc, refs["generator"] = self.locator(rec["generator_artifact"], "window_id", entry["window_id"])
            require(grow.get("work_id", work) == work and grow.get("allowed_work_ids") == [work], "generator_work_mismatch")
            cards = grow.get("cards")
            require(isinstance(cards, list) and all(isinstance(c, dict) for c in cards), "persisted_cards_invalid")
            matching = [c for c in cards if c.get("card_id") == entry["card_id"]]
            require(len(matching) == 1 and len({c.get("card_id") for c in cards}) == len(cards), "ambiguous_card_id")
            index = rec["generator_artifact"]["card_index"]
            require(type(index) is int and 0 <= index < len(cards) and cards[index] == matching[0], "card_index_mismatch")
            require(self.card_locations[refs["generator"]["path"]][entry["card_id"]] ==
                    [(entry["window_id"], gloc["line"], index)], "generator_card_id_ambiguous")
            card = matching[0]
            require(card.get("work_id") == work and card.get("allowed_work_ids") == [work]
                    and card.get("window_id") == entry["window_id"]
                    and card.get("chapter_id") == grow.get("chapter_id"), "card_identity_mismatch")
            refs["job"] = self.artifact(str(self.inputs.path(refs["generator"]["path"]).with_name("job_record.json")))
            job = strict(self.inputs.read(refs["job"]["path"], refs["job"]["sha256"]))
            require(isinstance(job, dict) and job.get("book") == work
                    and isinstance(job.get("input_artifact_hashes"), dict)
                    and isinstance(job.get("roles", ["rule_atom_read"]), list)
                    and isinstance(job.get("model"), str), "original_job_invalid")
            require(job.get("generator_reused", False) is False
                    and not str(job.get("execution_mode", "")).startswith("verifier_only"), "original_job_required")
            require(all(job["input_artifact_hashes"].get(label) == refs[name]["sha256"]
                        for label, name in (("coverage_partition.jsonl", "coverage"), ("sentences.jsonl", "sentences"))),
                    "original_job_source_mismatch")
            self.rules["job_manifest"](job, refs["generator"])
            origin = self.verify_attempt(entry, grow, card, job, refs)
        except (ValueError, KeyError, TypeError, OSError) as error:
            integrity.append(self.reason(error))
            origin = {**attempt_status(entry), "verified": False}
        candidate_hash = digest(canonical(card["normalized_card"])) if "normalized_card" in card else None
        key = grouping_key(work, refs, entry["window_id"], entry["card_id"], candidate_hash)
        # Unresolved identities must never be deduplicated as if their missing fields matched.
        identity_key = key if candidate_hash is not None and len(refs) == 4 else [*key, entry["attempt_artifact"]]
        group_id = digest(canonical(identity_key))
        sentence_rows, receipts, covloc = [], [], None
        if source_error:
            source_errors.append(source_error)
        window = None
        normalized_same = None
        selected_schema_valid = None
        if not integrity and not source_errors:
            try:
                matches = coverage.get(entry["window_id"], [])
                require(len(matches) == 1, "coverage_window_ambiguous")
                cov, covloc = matches[0]
                require(grow.get("role") == cov.get("role") and cov.get("role") in job.get("roles", ["rule_atom_read"]),
                        "source_role_mismatch")
                window, sentence_rows, receipts = self.source_window(work, grow, cov, sources, refs)
            except (ValueError, KeyError, TypeError, OSError) as error:
                source_errors.append(self.reason(error))
        if window is not None:
            repairs.extend(self.rules["envelope_errors"](grow, job["model"]))
            normalized, errors = self.core["validate_card"](card.get("generator_card"), window)
            stored, stored_errors = self.core["validate_card"](card.get("normalized_card"), window)
            selected_schema_valid = not errors and not stored_errors
            normalized_same = (canonical(normalized) == canonical(stored) == canonical(card.get("normalized_card")))
            if errors or stored_errors:
                repairs.append("selected_card_schema_invalid")
            if canonical(normalized) != canonical(stored) or canonical(stored) != canonical(card.get("normalized_card")):
                repairs.append("selected_card_normalization_mismatch")
            if card.get("accepted_for_verification") is not True or card.get("schema_errors") != []:
                repairs.append("selected_card_recorded_acceptance_invalid")
            if card.get("route") != (normalized or {}).get("primary_route"):
                repairs.append("selected_card_route_mismatch")
        decision = PARTITIONS[3] if integrity else PARTITIONS[2] if source_errors else PARTITIONS[1] if repairs else PARTITIONS[0]
        other = []
        counterpart_integrity = []
        if not integrity:
            available = recs[0].get("original", []) + recs[0].get("reverify", [])
            comparisons = [r for r in self.comparisons[(work, entry["card_id"])]
                           if any(a["attempt_artifact"] == entry["attempt_artifact"]
                                  for a in r.get("original", []) + r.get("reverify", []))]
            if comparisons:
                if len(comparisons) != 1 or any(comparisons[0].get(k, []) != recs[0].get(k, []) for k in ("original", "reverify")):
                    counterpart_integrity.append("comparison_disagrees")
            for old in available:
                if old["attempt_artifact"] == entry["attempt_artifact"]:
                    continue
                try:
                    other.append(self.verify_attempt(old, grow, card, job, refs))
                except (ValueError, KeyError, TypeError, OSError) as error:
                    counterpart_integrity.append(self.reason(error))
                    other.append({**attempt_status(old), "verified": False})
        if counterpart_integrity:
            integrity.extend(counterpart_integrity)
            decision = PARTITIONS[3]
        persisted_cards = grow.get("cards") if isinstance(grow.get("cards"), list) else []
        row = {"group_id": group_id, "grouping_key": key, "work_id": work, "cohort": entry["cohort"],
               "window_id": entry["window_id"], "chapter_id": grow.get("chapter_id"), "card_id": entry["card_id"],
               "candidate_sha256": candidate_hash, "artifacts": refs, "generator_row": gloc,
               "generator_card_sha256": digest(canonical(card.get("generator_card"))),
               "coverage_row": covloc, "sentence_rows": sentence_rows, "source_identity_receipts": receipts,
               "selected_card_validation": {
                   "source_window_built": window is not None,
                   "original_and_stored_schema_valid": selected_schema_valid,
                   "normalization_same": normalized_same,
                   "recorded_accepted_for_verification": card.get("accepted_for_verification")
                   if type(card.get("accepted_for_verification")) is bool else None,
                   "recorded_schema_errors": [] if card.get("schema_errors") == [] else ["recorded_schema_errors_not_empty"],
                   "recorded_schema_errors_sha256": digest(canonical(card.get("schema_errors")))},
               "decision": decision, "reason_codes": sorted(set(integrity or source_errors or repairs or ["structurally_source_complete"])),
               "parent_generation_error_codes": sorted(set(repairs)),
               "total_original_window_cards": len(persisted_cards),
               "rejected_sibling_count": sum(c.get("accepted_for_verification") is False and c != card for c in persisted_cards if isinstance(c, dict)),
               "accepted_sibling_count": sum(c.get("accepted_for_verification") is True and c != card for c in persisted_cards if isinstance(c, dict)),
               "originating_failed_attempts": [], "existing_other_attempt_statuses": other,
               "valid_other_counterpart_exists": any(a["verified"] and a["audited_status"] in ("entailed", "insufficient", "contradicted") for a in other),
               "precedence_unresolved": True, "selected_effective_attempt": None,
               "preparation_status": "pending_8001_no_dispatch" if decision == PARTITIONS[0] else "not_prepared",
               "boundaries": BOUNDARIES}
        return row, origin

    @staticmethod
    def reason(error):
        if isinstance(error, OSError):
            return "artifact_io_error"
        if isinstance(error, KeyError):
            return "required_binding_missing"
        if isinstance(error, TypeError):
            return "record_shape_invalid"
        # Exceptions originate only in pinned pure validators, never in model prose.
        text = str(error).split(":", 1)[0]
        return text if re.fullmatch(r"[a-z_]+", text) else "record_shape_invalid"

    def compile(self):
        frozen = {name: self.inputs.read(self.audit / name, pin) for name, pin in self.pins.items()}
        self.manifest, self.report = strict(frozen["manifest.json"]), strict(frozen["report.json"])
        for raw in frozen["input_hashes.jsonl"].splitlines():
            item = strict(raw)
            require(item["path"] not in self.inventory, "duplicate_audit_input")
            self.inventory[item["path"]] = item
        for name, target in (("card_reconciliation.jsonl", self.reconciliation), ("reverify_comparison.jsonl", self.comparisons)):
            for raw in frozen[name].splitlines():
                item = strict(raw)
                target[item["work"], item["card_id"]].append(item)
        by_work = defaultdict(list)
        for line, raw in enumerate(frozen["verifier_repair_queue.jsonl"].splitlines(), 1):
            entry = strict(raw)
            require(isinstance(entry, dict) and isinstance(entry.get("work"), str)
                    and isinstance(entry.get("attempt_artifact"), dict), "malformed_frozen_queue")
            require(entry.get("cohort") in self.manifest["cohorts"]
                    and entry["work"] in self.manifest["cohorts"][entry["cohort"]], "queue_cohort_mismatch")
            by_work[entry["work"]].append((line, entry, digest(raw)))
        require(sum(map(len, by_work.values())) == self.expected_count == self.report["verifier_repair_queue_rows"], "frozen_queue_count_mismatch")
        for work, entries in sorted(by_work.items()):
            refs, coverage, sources, source_error = {}, {}, {}, None
            try:
                cp, sp = self.provenance(work, "coverage_partition.jsonl"), self.provenance(work, "sentences.jsonl")
                refs["coverage"] = self.artifact(cp["path"], cp["recorded_sha256"])
                aliases = sorted(set(sp.get("matching_paths", [])))
                require(bool(aliases), "resolved_source_missing")
                aliases = [self.artifact(p, sp["recorded_sha256"]) for p in aliases]
                require(all(self.inputs.path(r["path"]).is_relative_to(self.inputs.root / "runs" / work) for r in aliases), "source_path_work_mismatch")
                refs["sentences"] = aliases[0]
                coverage = self.inputs.rows(refs["coverage"]["path"], refs["coverage"]["sha256"], "window_id")
                wanted = set()
                for _, entry, _ in entries:
                    for cov, _ in coverage.get(entry["window_id"], []):
                        wanted.update(cov.get("anchor_sentence_ids", []) + cov.get("attached_sentence_ids", []))
                sources = self.inputs.rows(refs["sentences"]["path"], refs["sentences"]["sha256"], "sentence_id", wanted)
            except (ValueError, KeyError, TypeError, OSError) as error:
                source_error = self.reason(error)
            for line, entry, row_hash in entries:
                row, origin = self.candidate(work, entry, sources, coverage, refs, source_error)
                origin.update(queue_line=line, queue_row_sha256=row_hash, queue_file_sha256=self.pins["verifier_repair_queue.jsonl"])
                group_id = row["group_id"]
                if group_id in self.groups:
                    prior = self.groups[group_id]
                    require(prior["grouping_key"] == row["grouping_key"], "group_hash_collision")
                    if prior["decision"] != row["decision"]:
                        prior["decision"] = PARTITIONS[3]
                        prior["reason_codes"] = ["originating_attempt_integrity_disagrees"]
                else:
                    self.groups[group_id] = row
                self.groups[group_id]["originating_failed_attempts"].append(origin)
                self.accounting.append({"queue_line": line, "queue_row_sha256": row_hash,
                    "queue_file_sha256": self.pins["verifier_repair_queue.jsonl"], "group_id": group_id,
                    "work_id": work, "cohort": entry["cohort"], "card_id": entry["card_id"],
                    "attempt": origin["attempt"], "finish_reason": origin["finish_reason"],
                    "error_codes": origin["error_codes"], "stored_verdict": origin["stored_verdict"],
                    "attempt_verified": origin["verified"], "out_of_scope": "cited_out_of_scope" in origin["error_codes"]})
            self.inputs.release()
        rows = sorted(self.groups.values(), key=lambda row: canonical(row["grouping_key"]))
        for row in rows:
            if row["decision"] != PARTITIONS[0]:
                row["preparation_status"] = "not_prepared"
            row["failed_attempt_row_count"] = len(row["originating_failed_attempts"])
            row["duplicate_failure_rows"] = row["failed_attempt_row_count"] - 1
            row["max_future_8001_calls_if_explicitly_authorized"] = int(row["decision"] == PARTITIONS[0])
        self.accounting.sort(key=lambda a: a["queue_line"])
        for entry in self.accounting:
            entry["decision"] = self.groups[entry["group_id"]]["decision"]
        require(len(self.accounting) == self.expected_count and len({a["queue_line"] for a in self.accounting}) == self.expected_count,
                "attempt_accounting_failed")
        require(sum(r["failed_attempt_row_count"] for r in rows) == len(self.accounting), "group_accounting_failed")
        return rows


def summarize(rows):
    return {"unique_candidates": len(rows), "attempt_rows": sum(r["failed_attempt_row_count"] for r in rows),
            "duplicate_failure_rows": sum(r["duplicate_failure_rows"] for r in rows),
            "works": len({r["work_id"] for r in rows}),
            "window_groups": len({tuple(r["grouping_key"][:5]) for r in rows}),
            "valid_other_counterpart_candidates": sum(r["valid_other_counterpart_exists"] for r in rows),
            "max_future_8001_calls_if_explicitly_authorized": sum(r["max_future_8001_calls_if_explicitly_authorized"] for r in rows)}


def build():
    inputs = Inputs(ROOT)
    code_refs = {}
    for label, name, pin in (("read_helpers", "build_generation_followup_inventory_v2.py", V2_PIN),
                             ("approved_helper", "approved_source_identity.py", HELPER_PIN),
                             ("current_core", "proposition_canary_run.py", CORE_PIN),
                             ("card_compiler", "prepare_card_reverify.py", COMPILER_PIN)):
        data = inputs.read(ROOT / "tools" / name, pin)
        code_refs[label] = inputs.pin(ROOT / "tools" / name)
        if label == "current_core":
            core_data = data
        if label == "card_compiler":
            compiler_data = data
    core, rules = compiler_rules(core_data, compiler_data)
    identity_path = BASE / "source_identity_bindings_approved_v1/manifest.json"
    declaration = strict(inputs.read(identity_path, IDENTITY_PIN))
    identity_refs = {"manifest": inputs.pin(identity_path)}
    for name, pin in declaration["outputs"].items():
        inputs.read(identity_path.with_name(name), pin["sha256"])
        identity_refs[name] = inputs.pin(identity_path.with_name(name))
    # Metadata-only helper reproduction. Selected actual source bytes are streamed below,
    # bound to their exact approved hash and final-rehashed by this inventory's guard.
    bindings = IDENTITY.load_approved_bindings(identity_path, IDENTITY_PIN, verify_sources=False)
    # Register the helper's evidence reads, without opening all 83 books as sentence sources.
    ns_ref = declaration["inputs"]["namespace_manifest"]
    inv_ref = declaration["inputs"]["inventory_manifest"]
    ns = strict(inputs.read(ns_ref["path"], ns_ref["sha256"]))
    inv = strict(inputs.read(inv_ref["path"], inv_ref["sha256"]))
    for ref, manifest in ((ns_ref, ns), (inv_ref, inv)):
        for name, pin in manifest["outputs"].items():
            inputs.read(inputs.path(ref["path"]).with_name(name), pin["sha256"])
    evidence = [strict(raw) for raw in inputs.read(inputs.path(ns_ref["path"]).with_name("per_work_bindings.jsonl")).splitlines()]
    source_paths = {e["artifacts"]["sentences"]["path"] for e in evidence}
    for ref in ns["inputs"]:
        if ref["path"] not in source_paths:
            inputs.read(ref["path"], ref["sha256"])
    inputs.read(ns["metadata_inventory"]["path"], ns["metadata_inventory"]["sha256"])
    for item in evidence:
        for ref in item["metadata_refs"]:
            inputs.read(ref["path"], ref["sha256"])
    builder = Builder(ROOT, AUDIT, PINS, bindings, identity_refs, core, rules)
    rows = builder.compile()
    v3_path = BASE / "generation_followup_inventory_v3/manifest.json"
    v3 = strict(inputs.read(v3_path, V3_PIN))
    repair_windows = set()
    name = "regeneration_windows_8000.jsonl"
    for raw in inputs.read(v3_path.with_name(name), v3["outputs"][name]["sha256"]).splitlines():
        repair_windows.add(tuple(strict(raw)["grouping_key"]))
    for row in rows:
        row["v3_generator_repair_window_crossref"] = tuple(row["grouping_key"][:5]) in repair_windows
        row["crossref_changes_decision"] = False
    report = {"schema": "verifier_followup_inventory.v1", "offline_only": True,
              "model_calls": 0, "network_calls": 0, "totals": summarize(rows),
              "partitions": {p: summarize([r for r in rows if r["decision"] == p]) for p in PARTITIONS},
              "by_work": {}, "by_cohort": {}, "attempt_counts": {},
              "boundaries": BOUNDARIES, "approved_binding_count": len(bindings),
              "precedence_unresolved": True,
              "window_group_counts_nonadditive_across_card_partitions": True,
              "call_bound_policy": "Conditional upper bound only; not mandatory calls or budget approval. Valid old counterparts do not select an effective verdict.",
              "source_cache_policy": "One source-file stream per work, full hash with selected-ID subset retained; final full rehash.",
              "source_identity_policy": "Exact original-file tuple only; ephemeral work_id projection; excluded work blocked; no derived source substitution.",
              "excluded_work_policy": {"work_id": IDENTITY.EXCLUDED_WORK, "source_binding_blocked": True,
                  "queue_attempt_rows": sum(a["work_id"] == IDENTITY.EXCLUDED_WORK for a in builder.accounting),
                  "derived_source_substitution": False, "conflicts_resolved": False},
              "checks": {"every_attempt_exactly_once": True, "one_partition_per_candidate": True,
                         "no_lost_records": True, "no_semantic_recomputation": True}}
    for field in ("work_id", "cohort"):
        target = "by_work" if field == "work_id" else "by_cohort"
        report[target] = {value: {"totals": summarize([r for r in rows if r[field] == value]),
                          "partitions": {p: summarize([r for r in rows if r[field] == value and r["decision"] == p]) for p in PARTITIONS}}
                          for value in sorted({r[field] for r in rows})}
    accounting = builder.accounting
    for field in ("attempt", "cohort", "work_id", "finish_reason", "decision", "out_of_scope"):
        report["attempt_counts"][field] = dict(sorted(Counter(str(a[field]) for a in accounting).items()))
    report["attempt_counts"]["error_family_overlap"] = dict(sorted(Counter(code for a in accounting for code in a["error_codes"]).items()))
    report["candidate_reason_counts"] = dict(sorted(Counter(code for r in rows for code in r["reason_codes"]).items()))
    report["attempt_counts"]["error_stage_overlap"] = {
        "scope": sum(a["out_of_scope"] for a in accounting),
        "format_or_contract": sum(any(c != "cited_out_of_scope" for c in a["error_codes"]) for a in accounting)}
    report["reverify_overlap"] = {
        "candidates_with_both_failed_attempt_types": sum({a["attempt"] for a in r["originating_failed_attempts"]} == {"original", "reverify_8001"} for r in rows),
        "candidates_with_available_other_attempt": sum(bool(r["existing_other_attempt_statuses"]) for r in rows),
        "valid_other_counterpart_candidates": sum(r["valid_other_counterpart_exists"] for r in rows)}
    report["conditional_call_bounds"] = {
        "max_8001_ready_card_calls_if_authorized": sum(r["decision"] == PARTITIONS[0] for r in rows),
        "max_8000_repair_window_calls_if_authorized": len({tuple(r["grouping_key"][:5]) for r in rows if r["decision"] == PARTITIONS[1]}),
        "mandatory_new_calls": 0, "dispatch_authorized": False}
    report["checks"]["all_457_attempts_verified"] = all(a["attempt_verified"] for a in accounting)
    report["checks"]["candidate_attempt_duplicate_arithmetic"] = (
        report["totals"]["unique_candidates"] + report["totals"]["duplicate_failure_rows"] == len(accounting))
    require(report["checks"]["candidate_attempt_duplicate_arithmetic"], "duplicate_arithmetic_failed")
    for field in ("unique_candidates", "attempt_rows", "duplicate_failure_rows", "max_future_8001_calls_if_explicitly_authorized"):
        require(sum(p[field] for p in report["partitions"].values()) == report["totals"][field], "partition_arithmetic_failed")
    products = {name: jsonl([r for r in rows if r["decision"] == p]) for name, p in zip(FILES, PARTITIONS)}
    products["attempt_accounting.jsonl"] = jsonl(accounting)
    products["report.json"] = encoded(report)
    products["report.md"] = ("# Offline Verifier Follow-up Inventory\n\n"
        "No requests, messages, prompts, new verdicts, dispatch, or certification. Historical precedence remains unresolved.\n\n"
        "## Totals\n\n```json\n" + encoded(report["totals"]).decode() + "```\n\n"
        "## Partitions\n\n```json\n" + encoded(report["partitions"]).decode() + "```\n\n"
        "## Reverify Overlap\n\n```json\n" + encoded(report["reverify_overlap"]).decode() + "```\n\n"
        + report["call_bound_policy"] + "\n").encode()
    inputs.read(Path(__file__))
    inputs.read(ROOT / "tests/test_verifier_followup_inventory.py")
    for path in set(inputs.observed) & set(builder.inputs.observed):
        require(inputs.observed[path] == builder.inputs.observed[path], "overlapping_input_pin_disagrees")
    manifest = {"schema": "verifier_followup_inventory.v1.manifest", "audit_dir": AUDIT.as_posix(),
                "audit_pins": PINS, "builder": inputs.pin(Path(__file__)),
                "tests": inputs.pin(ROOT / "tests/test_verifier_followup_inventory.py"), **code_refs,
                "approved_identity": identity_refs, "approved_keys": [dict(r["key"]) for r in bindings.values()],
                "v3_crossref": inputs.pin(v3_path), "v3_crossref_use": "advisory_exact_original_window_key_only",
                "candidate_hash_encoding": "sha256_canonical_stored_normalized_card_ascii_sorted_compact_json",
                "grouping_key": ["work", "original_generator_file_sha256", "original_coverage_sha256", "original_source_sha256", "window_id", "card_id", "candidate_sha256"],
                "original_execution_code_pins": [r for p, r in sorted(builder.inventory.items()) if p.startswith("tools/")],
                "actual_read_inputs": sorted({**inputs.observed, **builder.inputs.observed}.values(), key=lambda r: r["path"]),
                "outputs": {name: {"sha256": digest(data), "bytes": len(data)} for name, data in sorted(products.items())},
                "totals": report["totals"], "boundaries": BOUNDARIES,
                "materialization": "absent_only_exclusive_create_manifest_last",
                "manifest_integrity": "external_sha256_required_for_check"}
    inputs.recheck()
    builder.inputs.recheck()
    products["manifest.json"] = encoded(manifest)
    return products, report, (inputs, builder.inputs)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--materialize", choices=("newabsent",))
    mode.add_argument("--check", action="store_true")
    parser.add_argument("--manifest-sha256")
    args = parser.parse_args(argv)
    try:
        require(bool(args.manifest_sha256) == args.check, "external_manifest_pin_required_only_for_check")
        if args.materialize:
            require(not OUT.exists() and OUT.parent.is_dir(), "new_absent_output_directory_required")
        if args.check:
            require(re.fullmatch(r"[0-9a-f]{64}", args.manifest_sha256 or "")
                    and V2.file_hash(OUT / "manifest.json") == args.manifest_sha256, "output_manifest_hash_mismatch")
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
                    require((OUT / name).read_bytes() == data, "output_write_mismatch")
            with (OUT / "manifest.json").open("xb") as handle:
                handle.write(products["manifest.json"])
        print(json.dumps({"mode": "check" if args.check else "materialize" if args.materialize else "dry_run",
                          "manifest_sha256": digest(products["manifest.json"]), "totals": report["totals"],
                          "partitions": report["partitions"], "reverify_overlap": report["reverify_overlap"],
                          "candidate_reason_counts": report.get("candidate_reason_counts", {}),
                          "conditional_call_bounds": report.get("conditional_call_bounds", {}),
                          "checks": report.get("checks", {}),
                          "model_calls": 0, "network_calls": 0}, sort_keys=True))
        return 0
    except (ValueError, KeyError, TypeError, OSError) as error:
        print("FAIL: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
