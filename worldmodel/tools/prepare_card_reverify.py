#!/usr/bin/env python3
"""Compile pinned, card-scoped verifier inputs offline; never dispatch a request."""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys


CORE_PATH = Path(__file__).absolute().with_name("proposition_canary_run.py")
CORE_BYTES = CORE_PATH.read_bytes()
SPEC = importlib.util.spec_from_file_location("card_reverify_core", CORE_PATH)
C = importlib.util.module_from_spec(SPEC)
# exec avoids import-time bytecode writes, including during a dry run.
exec(compile(CORE_BYTES, str(CORE_PATH), "exec"), C.__dict__)
COMPILER_PATH = Path(__file__).absolute()
COMPILER_BYTES = COMPILER_PATH.read_bytes()
CANONICAL_PROMPT = Path(C.BASE) / C.VER_PROMPT_CONTRACT
SHA = re.compile(r"[0-9a-f]{64}\Z")
ARTIFACTS = ("generator", "generator_job", "coverage", "sentences")
BOUNDARIES = {"dispatch_authorized": False, "whole_generation_certified": False,
              "quality_certified": False, "no_runtime_effect": True,
              "automatic_promotion_permitted": False, "review_only": True,
              "input_status": "UNVERIFIED_verifier_INPUT"}
LEDGERS = ("verifier_inputs.jsonl", "rejected_cards.jsonl", "unselected_cards.jsonl",
           "generation_issues.jsonl")


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def canonical_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
                      allow_nan=False).encode("utf-8")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def candidate_sha256(card):
    return digest(canonical_bytes(card))


def strict_json(data):
    try:
        value = C.strict_json(data)
        canonical_bytes(value)  # Also reject finite JSON tokens overflowing to infinity.
        return value
    except RecursionError:
        raise ValueError("json_nesting_too_deep") from None


def safe_path(value):
    require(isinstance(value, (str, Path)), "invalid_path")
    text = str(value)
    require(text and not any(ord(ch) < 32 or 127 <= ord(ch) <= 159 for ch in text), "invalid_path")
    require(not text.startswith(("\\\\?\\", "\\\\.\\", "//?/", "//./")), "unsafe_device_path")
    path = Path(text)
    require(path.is_absolute() and not any(p in (".", "..") for p in text.replace("\\", "/").split("/")),
            "absolute_nontraversing_path_required")
    for part in path.parts[1:]:
        require(not part.endswith((".", " ")) and not any(ch in part for ch in '<>:"|?*'), "unsafe_path")
        require(not re.fullmatch(r"(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part), "unsafe_path")
    for node in (path, *path.parents):
        if os.path.lexists(node):
            info = node.lstat()
            require(not stat.S_ISLNK(info.st_mode)
                    and not (getattr(info, "st_file_attributes", 0) & 0x400), "unsafe_path_symlink")
    return path


def pin_shape(ref):
    require(isinstance(ref, dict) and set(ref) == {"path", "sha256"}, "bad_artifact_reference")
    require(isinstance(ref["sha256"], str) and SHA.fullmatch(ref["sha256"]), "invalid_sha256")
    require(isinstance(ref["path"], str), "invalid_path")
    return safe_path(ref["path"])


def identity(value, label):
    require(isinstance(value, str) and bool(value.strip()) and "|" not in value
            and not any(ord(ch) < 32 or 127 <= ord(ch) <= 159 for ch in value), "invalid_" + label)
    return value


def diagnostic_codes(errors):
    """Keep error codes, never arbitrary unknown field names or recorded prose."""
    if errors is None:
        return None
    if not isinstance(errors, list) or not all(isinstance(code, str) for code in errors):
        return ["recorded_schema_errors_invalid"]
    result = []
    for code in errors:
        if code.startswith("unknown_key:") or not re.fullmatch(r"[A-Za-z0-9_:.\-]+", code):
            prefix = code.split(":", 1)[0]
            code = prefix if re.fullmatch(r"[a-z_]+", prefix) else "unrecognized_schema_error"
        result.append(code)
    return result


class Inputs:
    """Invocation-local bytes, JSON and ID indexes; final checks never trust mtimes."""

    def __init__(self):
        self.files, self.objects, self.rows, self.indexes = {}, {}, {}, {}

    def read(self, ref):
        path = pin_shape(ref)
        if path in self.files:
            require(self.files[path][0] == ref["sha256"], "conflicting_path_pins")
            return self.files[path][1]
        require(path.is_file(), "input_file_required:" + str(path))
        data = path.read_bytes()
        require(digest(data) == ref["sha256"], "artifact_hash_mismatch:" + str(path))
        self.files[path] = (ref["sha256"], data)
        return data

    def local(self, path, expected=None):
        path = safe_path(path)
        pin = self.files[path][0] if path in self.files else digest(path.read_bytes())
        ref = {"path": str(path), "sha256": expected if expected is not None else pin}
        self.read(ref)
        return ref

    def obj(self, ref):
        data, path = self.read(ref), pin_shape(ref)
        if path not in self.objects:
            obj = strict_json(data.decode("utf-8"))
            require(isinstance(obj, dict), "json_object_required")
            self.objects[path] = obj
        return self.objects[path]

    def index(self, ref, key):
        data, path = self.read(ref), pin_shape(ref)
        if path not in self.rows:
            rows = [(i, strict_json(line.decode("utf-8"))) for i, line in enumerate(data.split(b"\n"), 1)
                    if line.strip()]
            require(all(isinstance(row, dict) for _, row in rows), "jsonl_object_required")
            self.rows[path] = rows
        if (path, key) not in self.indexes:
            result = {}
            for number, row in self.rows[path]:
                name = identity(row.get(key), key)
                require(name not in result, "duplicate_" + key)
                result[name] = (number, row)
            self.indexes[path, key] = result
        return self.indexes[path, key]

    def inventory(self):
        return [{"path": str(path), "sha256": pin} for path, (pin, _) in
                sorted(self.files.items(), key=lambda item: str(item[0]))]

    def recheck(self):
        for path, (pin, _) in self.files.items():
            require(safe_path(path).is_file() and digest(path.read_bytes()) == pin,
                    "artifact_changed_during_validation:" + str(path))


def job_manifest(job, generator_ref):
    hashes = job.get("output_file_hashes")
    if "output_file_hashes" not in job:
        return None
    require(isinstance(hashes, dict), "invalid_job_output_manifest")
    for name, pin in hashes.items():
        require(isinstance(name, str) and name and "\\" not in name and ":" not in name,
                "unsafe_job_output_path")
        parts = PurePosixPath(name).parts
        require(parts and not name.startswith("/") and "/".join(parts) == name
                and all(p not in (".", "..") and not p.endswith((".", " "))
                        and not any(ord(ch) < 32 or 127 <= ord(ch) <= 159 or ch in '<>"|?*' for ch in p)
                        for p in parts), "unsafe_job_output_path")
        require(isinstance(pin, str) and SHA.fullmatch(pin), "invalid_job_output_manifest")
    require(hashes.get(Path(generator_ref["path"]).name) == generator_ref["sha256"],
            "job_output_hash_mismatch:generator")
    return hashes


def envelope_errors(row, model):
    errors, meta = [], row.get("call_meta")
    if (not isinstance(meta, dict) or type(meta.get("http_status")) is not int
            or meta.get("http_status") != 200 or meta.get("model") != model
            or meta.get("finish_reason") != "stop" or "error" not in meta
            or meta["error"] is not None or meta.get("response_incomplete")):
        errors.append("generator_call_envelope_invalid")
    raw = row.get("raw_response")
    if isinstance(meta, dict) and "content_sha256" in meta:
        if not isinstance(raw, str) or meta["content_sha256"] != C.sha256_text(raw):
            errors.append("generator_content_hash_mismatch")
    if row.get("model_parse_ok") is not True or "parse_error" not in row or row["parse_error"] is not None:
        errors.append("generator_parse_status_invalid")
    try:
        payload = strict_json(raw) if isinstance(raw, str) else None
    except (ValueError, TypeError):
        payload = None
    proposed = payload.get("propositions") if isinstance(payload, dict) else None
    if (not isinstance(payload, dict) or set(payload) != {"propositions"}
            or not isinstance(proposed, list) or len(proposed) > C.MAX_CARDS_PER_WINDOW):
        errors.append("generator_raw_propositions_invalid")
    elif (type(row.get("proposed_count")) is not int or row["proposed_count"] != len(proposed)
          or not isinstance(row.get("cards"), list) or len(row["cards"]) != len(proposed)
          or any(not isinstance(item, dict) or item.get("card_id") != f"{row['window_id']}#{i}"
                 or "generator_card" not in item
                 or canonical_bytes(item["generator_card"]) != canonical_bytes(proposed[i])
                 for i, item in enumerate(row["cards"]))):
        errors.append("generator_card_correspondence_invalid")
    if not isinstance(row.get("cards"), list):
        errors.append("generator_cards_not_list")
    return errors


def compile_package(selection, selection_sha256):
    """Return reproducible bytes and the read set, without creating any output."""
    inputs = Inputs()
    selection_ref = {"path": str(safe_path(selection)), "sha256": selection_sha256}
    decision = inputs.obj(selection_ref)
    require(set(decision) == {"schema_version", "verifier_prompt", "worker_config", "sources"}
            and type(decision["schema_version"]) is int and decision["schema_version"] == 1,
            "unsupported_selection_schema")
    require(isinstance(decision["sources"], list) and bool(decision["sources"]), "explicit_sources_required")
    compiler = inputs.local(COMPILER_PATH, digest(COMPILER_BYTES))
    core = inputs.local(CORE_PATH, digest(CORE_BYTES))
    canonical_prompt = inputs.local(CANONICAL_PROMPT)
    prompt_bytes = inputs.read(decision["verifier_prompt"])
    require(prompt_bytes == inputs.read(canonical_prompt), "canonical_v3_prompt_required")
    text = prompt_bytes.decode("utf-8")
    require(text.count("[SYSTEM]") == text.count("[USER]") == 1
            and text.startswith("[SYSTEM]") and "<VERDICT_JSON>" in text
            and "</VERDICT_JSON>" in text and all(field in text for field in C.REQUIRED_VERIFIER_FIELDS),
            "canonical_v3_prompt_markers_required")
    system, user_template = text[len("[SYSTEM]"):].split("[USER]")
    system, user_template = system.strip("\n"), user_template.strip("\n")
    config = inputs.obj(decision["worker_config"])
    profiles = config.get("profiles")
    require(isinstance(profiles, dict) and isinstance(profiles.get("unstructured_analysis"), dict),
            "unstructured_analysis_profile_required")
    profile = profiles["unstructured_analysis"]
    require(isinstance(profile.get("model"), str) and bool(profile["model"].strip())
            and profile.get("thinking_disabled") is False
            and type(profile.get("max_model_len")) is int and profile["max_model_len"] >= 16000
            and type(profile.get("max_num_seqs")) is int and profile["max_num_seqs"] == 1
            and (profile.get("max_tokens") is None or
                 (type(profile["max_tokens"]) is int and profile["max_tokens"] >= 16000)),
            "incompatible_ver16000_profile")
    plan = {"profile": "unstructured_analysis", "model": profile["model"], "budget_plan": "ver16000",
            "max_tokens": 16000, "thinking_disabled": profile["thinking_disabled"],
            "max_model_len": profile["max_model_len"], "max_num_seqs": 1,
            "completion_requests_per_input": 1, "serial": True, "automatic_retries": 0,
            "dispatch_authorized": False}
    ledgers = {name: [] for name in LEDGERS}
    snapshots, seen, case_ids = [], set(), set()
    for source in decision["sources"]:
        require(isinstance(source, dict) and set(source) == set(ARTIFACTS) | {"work_id", "selected_cards"},
                "bad_source_shape")
        work = identity(source["work_id"], "work_id")
        refs = {key: {"path": str(pin_shape(source[key])), "sha256": source[key]["sha256"]}
                for key in ARTIFACTS}
        for ref in refs.values():
            inputs.read(ref)
        scope = (work, refs["generator"]["sha256"])
        require(scope not in seen, "duplicate_source_snapshot")
        seen.add(scope)
        job = inputs.obj(refs["generator_job"])
        require(job.get("book") == work, "job_work_mismatch")
        require(isinstance(job.get("model"), str) and bool(job["model"].strip()), "job_model_required")
        bindings = {"coverage_partition.jsonl": refs["coverage"]["sha256"],
                    "sentences.jsonl": refs["sentences"]["sha256"]}
        require(isinstance(job.get("input_artifact_hashes"), dict)
                and all(job["input_artifact_hashes"].get(k) == v for k, v in bindings.items()),
                "job_source_hash_mismatch")
        require(Path(refs["generator"]["path"]).parent == Path(refs["generator_job"]["path"]).parent,
                "generator_job_not_sibling")
        require(job.get("generator_reused", False) is False
                and not str(job.get("execution_mode", "")).startswith("verifier_only"),
                "original_generator_job_required")
        hashes = job_manifest(job, refs["generator"])
        coverage = inputs.index(refs["coverage"], "window_id")
        sentences = inputs.index(refs["sentences"], "sentence_id")
        rows = inputs.index(refs["generator"], "window_id")
        for _, row in (*coverage.values(), *sentences.values()):
            require(row.get("work_id") in (None, work), "source_work_mismatch")
        source_rows = {sid: row for sid, (_, row) in sentences.items()}
        require(isinstance(source["selected_cards"], list), "selected_cards_list_required")
        selected = {}
        for chosen in source["selected_cards"]:
            require(isinstance(chosen, dict) and set(chosen) == {"card_id", "candidate_sha256"},
                    "bad_selected_card_shape")
            cid = identity(chosen["card_id"], "card_id")
            require(cid not in selected, "duplicate_selection")
            require(isinstance(chosen["candidate_sha256"], str) and SHA.fullmatch(chosen["candidate_sha256"]),
                    "invalid_candidate_sha256")
            selected[cid] = chosen["candidate_sha256"]
        by_card, warnings = {}, {"raw_captures_not_validated", "historical_ok_not_certification"}
        if type(job.get("acceptance_contract_version")) is not int or job["acceptance_contract_version"] != 2:
            warnings.add("strict_v2_provenance_missing")
        if hashes is None:
            warnings.add("output_manifest_missing")
        start = {name: len(ledger) for name, ledger in ledgers.items()}
        for wid, (line_number, row) in rows.items():
            require(row.get("work_id", work) == work and row.get("allowed_work_ids") == [work],
                    "generator_row_work_mismatch")
            issues = envelope_errors(row, job["model"])
            window = None
            if wid not in coverage:
                issues.append("coverage_window_missing")
            else:
                try:
                    window = C.build_window({**coverage[wid][1], "work_id": work}, source_rows)
                except (ValueError, TypeError, KeyError) as error:
                    issues.append("source_window_invalid:" + str(error).split(":", 1)[0])
            if window is not None and (row.get("chapter_id") != window["chapter_id"]
                                       or row.get("sentence_ids") != window["sentence_ids"]):
                issues.append("generator_row_source_binding_mismatch")
            meta = row.get("call_meta")
            capture = meta.get("capture_dir") if isinstance(meta, dict) else None
            capture_match = re.search(r"(?:^|/)calls/([0-9]{6,}_generator)$", capture.replace("\\", "/")) \
                if isinstance(capture, str) else None
            if capture_match is None or hashes is None or not all(
                    "calls/" + capture_match[1] + "/" + filename in hashes
                    for filename in ("request_body.bin", "response_body.bin", "journal.jsonl")):
                warnings.add("raw_captures_missing_or_unpinned")
            base = {"work_id": work, "window_id": wid, "chapter_id": row.get("chapter_id"),
                    "generator_line": line_number, **refs, **BOUNDARIES}
            if issues:
                ledgers["generation_issues.jsonl"].append({**base, "error_codes": sorted(set(issues)),
                    "observed_card_count": len(row["cards"]) if isinstance(row.get("cards"), list) else None,
                    "recorded_model_parse_ok": row.get("model_parse_ok"),
                    "recorded_parse_error_present": row.get("parse_error") is not None,
                    "http_status": meta.get("http_status") if isinstance(meta, dict) else None})
            for position, item in enumerate(row["cards"] if isinstance(row.get("cards"), list) else []):
                require(isinstance(item, dict), "generator_card_not_object")
                cid = identity(item.get("card_id"), "card_id")
                require(cid not in by_card, "duplicate_card_id")
                by_card[cid] = item
                require(item.get("work_id") == work and item.get("allowed_work_ids") == [work],
                        "card_work_mismatch")
                original, schema_errors = (C.validate_card(item.get("generator_card"), window)
                                           if window is not None else (None, []))
                normalized, normalized_errors = (C.validate_card(item.get("normalized_card"), window)
                                                 if window is not None else (None, []))
                consistency = []
                if item.get("window_id") != wid or (window is not None
                        and item.get("chapter_id") != window["chapter_id"]):
                    consistency.append("card_window_binding_mismatch")
                if window is None:
                    consistency.append("schema_span_unassessable_without_source_window")
                elif not schema_errors and (normalized_errors or canonical_bytes(original) != canonical_bytes(normalized)
                                            or canonical_bytes(normalized) != canonical_bytes(item.get("normalized_card"))):
                    consistency.append("normalized_card_mismatch")
                if item.get("accepted_for_verification") is not True:
                    consistency.append("inherited_accepted_flag_not_true")
                if item.get("schema_errors") != []:
                    consistency.append("inherited_schema_errors_not_empty")
                proposed_card = item.get("generator_card")
                proposed_route = proposed_card.get("primary_route") if isinstance(proposed_card, dict) else None
                route = proposed_route if isinstance(proposed_route, str) and proposed_route in C.PRIMARY_ROUTES else None
                if item.get("route") != route:
                    consistency.append("inherited_route_mismatch")
                recorded = item.get("schema_errors")
                if window is not None and item.get("accepted_for_verification") is True and schema_errors:
                    consistency.append("inherited_acceptance_disagrees_with_current_schema")
                if window is not None and recorded is not None and canonical_bytes(recorded) != canonical_bytes(schema_errors):
                    consistency.append("inherited_schema_errors_disagree_with_current_schema")
                ledger = {**base, "card_id": cid, "card_position": position, "route": route,
                          "candidate_sha256": candidate_sha256(original) if original is not None else None,
                          "generator_card_sha256": candidate_sha256(item.get("generator_card")),
                          "recorded_accepted_flag": "true" if item.get("accepted_for_verification") is True else
                                                    ("false" if item.get("accepted_for_verification") is False else
                                                     "missing_or_invalid"),
                          "original_error_codes": diagnostic_codes(recorded),
                          "original_error_codes_sha256": candidate_sha256(recorded),
                          "observed_error_codes": diagnostic_codes(schema_errors),
                          "normalized_error_codes": diagnostic_codes(normalized_errors), "disagreements": consistency,
                          "parent_generation_error_codes": sorted(set(issues)),
                          "schema_span_status": "invalid" if schema_errors else
                                                ("valid" if window is not None else "unassessable")}
                if cid in selected:
                    require(not issues, "selected_generator_invalid:" + ",".join(issues))
                    require(not schema_errors and not normalized_errors and not consistency,
                            "selected_card_invalid:" + ",".join(schema_errors + normalized_errors + consistency))
                    require(selected[cid] == candidate_sha256(original), "candidate_hash_mismatch")
                    evidence = C.render_evidence(original, window)
                    case_id = f"{work}|{wid}|{cid}"
                    require(case_id not in case_ids, "duplicate_selected_case_id")
                    case_ids.add(case_id)
                    user = C.render(user_template, {"work_id": work, "case_id": case_id,
                        "evidence_block": evidence, "candidate_json": json.dumps(original, ensure_ascii=False)})
                    ledgers["verifier_inputs.jsonl"].append({**ledger, "case_id": case_id,
                        "normalized_card": original, "evidence_block": evidence,
                        "evidence_sha256": C.sha256_text(evidence), "verifier_prompt": decision["verifier_prompt"],
                        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                        "request_plan": plan})
                else:
                    ledgers["rejected_cards.jsonl" if schema_errors else "unselected_cards.jsonl"].append(ledger)
        require(set(selected) <= set(by_card), "selected_generator_card_missing")
        counts = {name.removesuffix(".jsonl"): len(ledgers[name]) - start[name] for name in LEDGERS}
        require(sum(counts[name] for name in ("verifier_inputs", "rejected_cards", "unselected_cards"))
                == len(by_card), "card_accounting_mismatch")
        snapshots.append({"work_id": work, **refs, "inventoried_windows": len(rows),
                          "inventoried_cards": len(by_card), "counts": counts,
                          "provenance_warnings": sorted(warnings),
                          "legacy_input": bool(warnings & {"strict_v2_provenance_missing", "output_manifest_missing",
                                                           "raw_captures_missing_or_unpinned"}),
                          "acceptance_contract_version": job.get("acceptance_contract_version"),
                          "strict_v2_provenance_validated": False, **BOUNDARIES})
    require(bool(ledgers["verifier_inputs.jsonl"]), "explicit_selected_cards_required")
    outputs = {name: b"".join(canonical_bytes(row) + b"\n" for row in rows) for name, rows in ledgers.items()}
    counts = {name.removesuffix(".jsonl"): len(rows) for name, rows in ledgers.items()}
    total = sum(snapshot["inventoried_cards"] for snapshot in snapshots)
    require(counts["verifier_inputs"] + counts["rejected_cards"] + counts["unselected_cards"] == total,
            "card_accounting_mismatch")
    per_work_route, per_work_counts = [], []
    for work in sorted({snapshot["work_id"] for snapshot in snapshots}):
        work_counts = {name.removesuffix(".jsonl"): sum(row["work_id"] == work for row in ledgers[name])
                       for name in LEDGERS}
        per_work_counts.append({"work_id": work, "counts": work_counts,
                               "inventoried_cards": sum(work_counts[name] for name in
                                   ("verifier_inputs", "rejected_cards", "unselected_cards"))})
        for name in LEDGERS[:3]:
            counter = Counter(row["route"] or "unclassified" for row in ledgers[name] if row["work_id"] == work)
            per_work_route.extend({"work_id": work, "ledger": name, "route": route, "count": count}
                                  for route, count in sorted(counter.items()))
    report = {"schema_version": 1, "selection": selection_ref, "compiler": compiler, "strict_core": core,
              "canonical_verifier_prompt": canonical_prompt, "worker_config": decision["worker_config"],
              "request_plan": plan, "snapshots": snapshots, "counts": counts,
              "inventoried_cards": total, "accounting_balanced": True,
              "per_work_counts": per_work_counts, "per_work_route": per_work_route,
              "input_hash_inventory": inputs.inventory(),
              "output_file_hashes": {name: digest(data) for name, data in outputs.items()},
              "inventory_scope": "All cards and windows in the exact full pinned generator snapshots only.",
              "provenance_policy": "All historical snapshots are UNVERIFIED verifier INPUT; raw captures are not validated.",
              **BOUNDARIES}
    outputs["preparation_report.json"] = canonical_bytes(report) + b"\n"
    manifest = {"schema_version": 1, "selection": selection_ref,
                "input_hash_inventory": inputs.inventory(),
                "output_file_hashes": {name: digest(data) for name, data in outputs.items()}, **BOUNDARIES}
    outputs["package_manifest.json"] = canonical_bytes(manifest) + b"\n"
    return outputs, report, inputs


def prepare(selection, selection_sha256, out_dir, *, materialize=False):
    out = safe_path(out_dir)
    require(not os.path.lexists(out), "absent_only_output_exists")
    require(out.parent.is_dir(), "output_parent_must_exist")
    outputs, report, inputs = compile_package(selection, selection_sha256)
    inputs.recheck()
    safe_path(out)
    require(not os.path.lexists(out), "absent_only_output_exists")
    if materialize:
        out.mkdir(exist_ok=False)
        for name, data in outputs.items():
            with (out / name).open("xb") as handle:
                handle.write(data)
    return {"dry_run": not materialize, "package_manifest_sha256": digest(outputs["package_manifest.json"]),
            "report": report, **BOUNDARIES}


def verify_package(package, manifest_sha256):
    folder = safe_path(package)
    require(folder.is_dir(), "package_directory_required")
    stored = Inputs()
    manifest_ref = {"path": str(folder / "package_manifest.json"), "sha256": manifest_sha256}
    manifest = stored.obj(manifest_ref)
    require(set(manifest) == {"schema_version", "selection", "input_hash_inventory", "output_file_hashes"}
            | set(BOUNDARIES) and type(manifest["schema_version"]) is int and manifest["schema_version"] == 1,
            "invalid_package_manifest")
    hashes = manifest["output_file_hashes"]
    require(isinstance(hashes, dict) and set(hashes) == set(LEDGERS) | {"preparation_report.json"},
            "incomplete_output_hash_inventory")

    def check_directory():
        require(stat.S_ISDIR(safe_path(folder).lstat().st_mode), "package_directory_required")
        entries = list(folder.iterdir())
        require({path.name for path in entries} == set(hashes) | {"package_manifest.json"},
                "unexpected_package_entries")
        for path in entries:
            require(stat.S_ISREG(safe_path(path).lstat().st_mode), "package_regular_file_required")

    check_directory()
    for name, pin in hashes.items():
        stored.read({"path": str(folder / name), "sha256": pin})
    selection = manifest["selection"]
    pin_shape(selection)
    outputs, report, inputs = compile_package(selection["path"], selection["sha256"])
    check_directory()
    for name, expected in outputs.items():
        path = folder / name
        actual = stored.read(manifest_ref if name == "package_manifest.json" else
                             {"path": str(path), "sha256": hashes[name]})
        require(actual == expected, "package_reconstruction_mismatch:" + name)
    inputs.recheck()
    stored.recheck()
    check_directory()
    return {"package_verified": True, "package_manifest_sha256": manifest_sha256,
            "counts": report["counts"], "inventoried_cards": report["inventoried_cards"], **BOUNDARIES}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selection")
    parser.add_argument("--selection-sha256")
    parser.add_argument("--out-dir", help="absolute absent path with existing parent")
    parser.add_argument("--materialize", action="store_true")
    parser.add_argument("--verify-package", help="absolute existing package directory")
    parser.add_argument("--package-manifest-sha256", help="external pin for package_manifest.json")
    args = parser.parse_args(argv)
    try:
        if args.verify_package is not None:
            require(not any((args.selection, args.selection_sha256, args.out_dir, args.materialize))
                    and args.package_manifest_sha256 is not None, "exclusive_verify_mode_and_manifest_pin_required")
            result = verify_package(args.verify_package, args.package_manifest_sha256)
        else:
            require(all((args.selection, args.selection_sha256, args.out_dir))
                    and args.package_manifest_sha256 is None, "selection_pin_and_output_required")
            result = prepare(args.selection, args.selection_sha256, args.out_dir, materialize=args.materialize)
    except (ValueError, OSError, TypeError, KeyError, UnicodeError, RecursionError) as error:
        print("FAIL: " + ("json_nesting_too_deep" if isinstance(error, RecursionError) else str(error)), file=sys.stderr)
        return 2
    print(canonical_bytes(result).decode("ascii"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
