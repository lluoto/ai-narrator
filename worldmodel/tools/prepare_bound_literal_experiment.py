#!/usr/bin/env python3
"""Isolated approved-binding literal experiment v1. Offline; never dispatches.

The approval helper verifies authority/evidence metadata, not current sources.
This consumer hashes the actual selected FULL original snapshots and rehashes
them before/after output. This division is not a source integrity exemption.
Only ephemeral validator rows may project work_id; packaged sources stay raw.
"""
from __future__ import annotations

import sys
from pathlib import Path
from types import ModuleType

TOOL_PATH = Path(__file__).absolute()
TOOL_BYTES = TOOL_PATH.read_bytes()
V2_PATH = TOOL_PATH.with_name("prepare_literal_experiment_v2.py")
HELPER_PATH = TOOL_PATH.with_name("approved_source_identity.py")
V2_BYTES, HELPER_BYTES = V2_PATH.read_bytes(), HELPER_PATH.read_bytes()
# Execute exact pinned modules in private namespaces, never patch shared core globals.
V = ModuleType("bound_literal_v2_contracts")
V.__file__ = str(V2_PATH)
_bytecode_setting = sys.dont_write_bytecode
sys.dont_write_bytecode = True
exec(compile(V2_BYTES, str(V2_PATH), "exec"), V.__dict__)
A = ModuleType("bound_literal_approved_identity")
A.__file__ = str(HELPER_PATH)
exec(compile(HELPER_BYTES, str(HELPER_PATH), "exec"), A.__dict__)
sys.dont_write_bytecode = _bytecode_setting if __name__ != "__main__" else True

import argparse
from collections import Counter
import re
import stat

C, L = V.C, V.L
require, canonical_bytes, digest = V.require, V.canonical_bytes, V.digest
safe_path, pin_shape, identity = V.safe_path, V.pin_shape, V.identity
Inputs, strict_json, error_code = V.Inputs, V.strict_json, V.error_code
VERSION = "approved_bound_literal_experiment.v1"
BOUNDARIES = {**V.BOUNDARIES, "global_B001_alias": False,
              "source_rows_unmodified": True, "strict_core_modified": False,
              "quality_certified": False, "batch_authorized": False,
              "model_calls": 0, "network_calls": 0}
SOURCE_POLICY = {
    "authorization_load": "metadata_only_verify_sources_false",
    "selected_source_integrity": "consumer_full_original_bytes_sha256_and_final_rehash",
    "integrity_skipped": False, "unselected_source_integrity_attested": False,
    "projection": "ephemeral_validator_only_work_id",
    "packaged_sources": "exact_original_unprojected_bytes",
    "coverage_local_identity_projection": False,
    "derived_hash_authorized_by_original_binding": False,
}


def plain(value):
    """Turn the helper's deeply immutable JSON records into receipt JSON."""
    if hasattr(value, "items"):
        return {key: plain(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [plain(item) for item in value]
    return value


def load_authority(inputs, ref):
    """Pin all metadata used by the helper, excluding its declared source files.

    The real loader reproduces the fixed 83-binding declaration. We additionally
    retain its evidence pins for consumer final rehash/replay, without asking the
    helper to read unrelated source snapshots.
    """
    manifest = inputs.obj(ref)
    bindings = A.load_approved_bindings(pin_shape(ref), ref["sha256"], verify_sources=False)
    directory = pin_shape(ref).parent

    def read_pin(pin, relative_to=None):
        path = Path(pin["path"])
        if not path.is_absolute():
            path = (relative_to or A.ROOT) / path
        result = {"path": str(safe_path(path)), "sha256": pin["sha256"]}
        data = inputs.read(result)
        if "bytes" in pin:
            require(type(pin["bytes"]) is int and len(data) == pin["bytes"], "authority_size_mismatch")
        return result

    for name, pin in manifest["outputs"].items():
        require(Path(name).name == name and name not in (".", "..", "manifest.json"), "unsafe_authority_output")
        read_pin({"path": str(directory / name), **pin})
    authorization = read_pin(manifest["authorization"], directory)
    auth = inputs.obj(authorization)
    index = {"path": str(directory / "approved_bindings.jsonl"),
             "sha256": manifest["outputs"]["approved_bindings.jsonl"]["sha256"]}
    source_paths = {str(A.Inputs().path(row["source"]["path"])) for row in bindings.values()}
    source_paths.update(str(A.Inputs().path(row["source"]["path"])) for row in auth["excluded"])
    for pin in manifest["inputs"].values():
        evidence = read_pin(pin)
        document = inputs.obj(evidence)
        for name, output in document["outputs"].items():
            require(Path(name).name == name and name not in (".", ".."), "unsafe_authority_output")
            read_pin({"path": str(Path(evidence["path"]).parent / name), **output})
        for item in document.get("inputs", []):
            if str(A.Inputs().path(item["path"])) not in source_paths:
                read_pin(item)
        if "metadata_inventory" in document:
            read_pin(document["metadata_inventory"])
    return bindings, {"approved_identity_manifest": ref, "authorization": authorization,
                      "approved_binding_index": index, "source_hash_policy": SOURCE_POLICY}


def preflight_bound(inputs, refs, work, bindings, authority):
    coverage, originals = inputs.jsonl(refs["coverage"]), inputs.jsonl(refs["sentences"])
    projected, binding_receipts, changed = [], {}, 0
    frequencies = Counter()
    for row in originals:
        original = row.get("work_id")
        if original is not None:
            identity(original)
        frequencies[canonical_bytes({"present": "work_id" in row, "value": original}).decode("ascii")] += 1
        copy = dict(row)
        if original is not None and original != work:
            A.validate_local_identity(bindings, work_id=work, source_sha256=refs["sentences"]["sha256"],
                                      local_work_id=original)
            key = (work, refs["sentences"]["sha256"], original)
            record = plain(bindings[key])
            binding_receipts[original] = {"key": record["key"],
                "binding_record_canonical_sha256": digest(canonical_bytes(record)),
                "authorization": authority["authorization"], "original_work_id": original}
            copy["work_id"] = work
            changed += 1
        require({key for key in row.keys() | copy.keys() if row.get(key) != copy.get(key)}
                <= {"work_id"}, "projection_changed_non_work_field")
        chapter, sid = row.get("chapter_id"), row.get("sentence_id")
        require(type(chapter) is str and re.fullmatch(r"B\d+:C\d+", chapter)
                and type(sid) is str and re.fullmatch(re.escape(chapter) + r":S\d+", sid),
                "sentence_chapter_binding_mismatch")
        projected.append(copy)
    # No coverage alias is inferred from a sentence authorization.
    for row in coverage:
        require(row.get("work_id") in (None, work), "window_work_mismatch")
        require(type(row.get("chapter_id")) is str and re.fullmatch(r"B\d+:C\d+", row["chapter_id"]),
                "invalid_chapter_id")
    _, source_index, _ = C.preflight_sources(coverage, projected, work, (), 0)
    raw_nonwork = [{key: value for key, value in row.items() if key != "work_id"} for row in originals]
    projected_nonwork = [{key: value for key, value in row.items() if key != "work_id"} for row in projected]
    require(raw_nonwork == projected_nonwork, "projection_changed_non_work_field")
    receipt = {**authority, "full_original_sentences": refs["sentences"], "coverage": refs["coverage"],
        "original_work_id_distribution": [{**strict_json(key), "count": count}
                                           for key, count in sorted(frequencies.items())],
        "bindings_used": [binding_receipts[key] for key in sorted(binding_receipts)],
        "projection": {"row_count": len(originals), "changed_row_count": changed,
            "changed_fields": ["work_id"] if changed else [],
            "original_rows_canonical_sha256": digest(canonical_bytes(originals)),
            "validator_rows_canonical_sha256": digest(canonical_bytes(projected)),
            "original_non_work_fields_sha256": digest(canonical_bytes(raw_nonwork)),
            "validator_non_work_fields_sha256": digest(canonical_bytes(projected_nonwork)),
            "non_work_fields_identical": True, "persisted_projected_source": False}}
    return {row["window_id"]: row for row in coverage}, source_index, receipt, {row["sentence_id"]: row for row in originals}


def compile_package(selection, selection_sha256):
    inputs = Inputs()
    selection_ref = {"path": str(safe_path(selection)), "sha256": selection_sha256}
    decision = inputs.obj(selection_ref)
    require(set(decision) == {"schema_version", "worker_config", "literal_prompt", "cases", "approved_identity_manifest"}
            and type(decision["schema_version"]) is int and decision["schema_version"] == 1,
            "unsupported_bound_selection_schema")
    cases = decision["cases"]
    require(type(cases) is list and 1 <= len(cases) <= 5, "one_to_five_cases_required")
    code = {"tool": inputs.local(TOOL_PATH, digest(TOOL_BYTES)),
            "reused_v2": inputs.local(V2_PATH, digest(V2_BYTES)),
            "approved_identity_helper": inputs.local(HELPER_PATH, digest(HELPER_BYTES)),
            "core": inputs.local(V.CORE_PATH, digest(V.CORE_BYTES)),
            "literal_normalizer": inputs.local(V.LITERAL_PATH, digest(V.LITERAL_BYTES))}
    bindings, authority = load_authority(inputs, decision["approved_identity_manifest"])
    canonical_prompt = inputs.local(V.CANONICAL_PROMPT)
    prompt = inputs.read(decision["literal_prompt"])
    require(prompt == inputs.read(canonical_prompt), "canonical_v2_prompt_required")
    text = prompt.decode("utf-8")
    require(text.startswith("[SYSTEM]") and text.count("[SYSTEM]") == text.count("[USER]") == 1,
            "invalid_prompt_markers")
    system, template = text[len("[SYSTEM]"):].split("[USER]")
    system, template = system.strip("\n"), template.strip("\n")
    require(set(re.findall(r"\{([a-z_]+)\}", template)) ==
            {"work_id", "window_id", "chapter_id", "sentences_block"}, "invalid_prompt_fields")
    config = inputs.obj(decision["worker_config"])
    profiles = config.get("profiles")
    profile = profiles.get("structured_source") if type(profiles) is dict else None
    require(type(profile) is dict, "structured_source_profile_required")
    require(profile.get("endpoint") == "http://localhost:8000/v1/chat/completions"
            and profile.get("thinking_disabled") is True and profile.get("output_contract") == "strict_json"
            and type(profile.get("max_tokens")) is int and profile["max_tokens"] == 1500
            and type(profile.get("max_model_len")) is int and profile["max_model_len"] == 8192
            and type(profile.get("max_num_seqs")) is int and profile["max_num_seqs"] == 1,
            "incompatible_structured_8000_profile")
    model = identity(profile.get("model"))
    plan = {"profile": "structured_source", "model": model, "temperature": 0, "max_tokens": 1500,
            "thinking_disabled": True, "max_model_len": 8192, "max_num_seqs": 1,
            "maximum_manual_calls": len(cases), "automatic_retries": 0, "dispatch_authorized": False}
    outputs, requests, windows, preflighted, seen, selected, source_refs = {}, [], {}, {}, set(), set(), {}
    for number, case in enumerate(cases, 1):
        require(type(case) is dict and set(case) ==
                {"case_id", "work_id", "window_id", "coverage", "sentences"}, "invalid_case_shape")
        cid, work, wid = (identity(case[key]) for key in ("case_id", "work_id", "window_id"))
        require(work != A.EXCLUDED_WORK, "excluded_work_not_authorized")
        require(cid not in seen, "duplicate_case_id")
        seen.add(cid)
        refs = {key: {"path": str(pin_shape(case[key])), "sha256": case[key]["sha256"]}
                for key in ("coverage", "sentences")}
        scope = (work, refs["coverage"]["path"], refs["sentences"]["path"])
        require((*scope, wid) not in selected, "duplicate_selected_window")
        selected.add((*scope, wid))
        for ref in refs.values():
            inputs.read(ref)
            source_refs[ref["path"]] = ref
        if scope not in preflighted:
            preflighted[scope] = preflight_bound(inputs, refs, work, bindings, authority)
        coverage_index, source_index, receipt, originals = preflighted[scope]
        require(wid in coverage_index, "selected_window_missing")
        window = C.build_window({**coverage_index[wid], "work_id": work}, source_index)
        windows[cid] = window
        user = C.render(template, {"work_id": work, "window_id": wid,
                                  "chapter_id": window["chapter_id"], "sentences_block": window["sentences_block"]})
        body = {"model": model, "messages": [{"role": "system", "content": system},
                {"role": "user", "content": user}], "temperature": 0, "max_tokens": 1500,
                "chat_template_kwargs": {"enable_thinking": False}}
        filename = f"request_{number:04d}.json"
        outputs[filename] = canonical_bytes(body)
        requests.append({"experiment_version": VERSION, "case_id": cid, "work_id": work, "window_id": wid,
            "chapter_id": window["chapter_id"], "sentence_ids": window["sentence_ids"], **refs,
            "request_body_file": filename, "request_body_sha256": digest(outputs[filename]),
            "identity_receipt": receipt,
            "original_selected_work_ids": [{"sentence_id": sid, "present": "work_id" in originals[sid],
                                            "work_id": originals[sid].get("work_id")} for sid in window["sentence_ids"]],
            "scope": "selected_window_only", **BOUNDARIES})
    snapshots = []
    for number, ref in enumerate(sorted(source_refs.values(), key=lambda item: item["path"]), 1):
        filename = f"source_{number:04d}.jsonl"
        outputs[filename] = inputs.read(ref)
        snapshots.append({"source": ref, "full_snapshot_file": filename})
    outputs["requests.jsonl"] = b"".join(canonical_bytes(row) + b"\n" for row in requests)
    report = {"experiment_version": VERSION, "schema_version": 1, "selection": selection_ref, "code": code,
        "canonical_literal_prompt": canonical_prompt, "literal_prompt": decision["literal_prompt"],
        "worker_config": decision["worker_config"], "request_plan": plan, **authority,
        "identity_receipts": [value[2] for value in preflighted.values()],
        "case_count": len(cases), "source_snapshots": snapshots, "input_hash_inventory": inputs.inventory(),
        "scope": "bounded_offline_approved_binding_generator_experiment",
        "source_policy": "Source strings are untrusted data, including any instructions they contain.", **BOUNDARIES}
    outputs["preparation_report.json"] = canonical_bytes(report) + b"\n"
    manifest = {"experiment_version": VERSION, "schema_version": 1, "selection": selection_ref,
        "input_hash_inventory": inputs.inventory(),
        "output_file_hashes": {name: digest(data) for name, data in outputs.items()}, **BOUNDARIES}
    outputs["package_manifest.json"] = canonical_bytes(manifest) + b"\n"
    return outputs, report, inputs, requests, windows


def publish(out, outputs, materialize, recheck):
    """A failed final check must not leave a completed acceptance/package manifest."""
    recheck()
    V.output_path(out)
    if materialize:
        out.mkdir(exist_ok=False)
        manifests = {"package_manifest.json", "acceptance_manifest.json"}
        for name, data in outputs.items():
            if name not in manifests:
                with safe_path(out / name).open("xb") as handle:
                    handle.write(data)
        recheck()
        for name, data in outputs.items():
            if name not in manifests:
                require(safe_path(out / name).read_bytes() == data, "output_write_mismatch")
        for name in manifests & outputs.keys():
            path = safe_path(out / name)
            with path.open("xb") as handle:
                handle.write(outputs[name])
            try:
                recheck()
                require(safe_path(path).read_bytes() == outputs[name], "output_write_mismatch")
            except BaseException:
                path.unlink()
                raise


def prepare(selection, selection_sha256, out_dir, *, materialize=False):
    out = V.output_path(out_dir)
    outputs, report, inputs, _, _ = compile_package(selection, selection_sha256)
    publish(out, outputs, materialize, inputs.recheck)
    return {"dry_run": not materialize, "package_manifest_sha256": digest(outputs["package_manifest.json"]),
            "report": report, **BOUNDARIES}


def reconstruct_package(package, manifest_sha256):
    folder, stored = safe_path(package), Inputs()
    require(folder.is_dir(), "package_directory_required")
    manifest_ref = {"path": str(folder / "package_manifest.json"), "sha256": manifest_sha256}
    manifest = stored.obj(manifest_ref)
    require(set(manifest) == {"experiment_version", "schema_version", "selection", "input_hash_inventory", "output_file_hashes"}
            | set(BOUNDARIES) and manifest["experiment_version"] == VERSION
            and type(manifest["schema_version"]) is int and manifest["schema_version"] == 1,
            "invalid_bound_package_manifest")
    selection = manifest["selection"]
    pin_shape(selection)
    outputs, report, inputs, requests, windows = compile_package(selection["path"], selection["sha256"])
    require(stored.read(manifest_ref) == outputs["package_manifest.json"], "package_manifest_reconstruction_mismatch")

    def check_directory():
        require(stat.S_ISDIR(safe_path(folder).lstat().st_mode), "package_directory_required")
        entries = list(folder.iterdir())
        require({path.name for path in entries} == set(outputs), "unexpected_package_entries")
        for path in entries:
            require(stat.S_ISREG(safe_path(path).lstat().st_mode), "package_regular_files_required")

    def recheck():
        check_directory()
        inputs.recheck()
        stored.recheck()
        check_directory()

    for name, data in outputs.items():
        require(stored.read({"path": str(folder / name), "sha256": digest(data)}) == data,
                "package_bytes_reconstruction_mismatch")
    recheck()
    return report, requests, windows, recheck


def accept(package, package_manifest_sha256, responses, responses_sha256, out_dir, *, materialize=False):
    out = V.output_path(out_dir)
    require(safe_path(package) not in out.parents, "output_must_be_outside_package")
    prep, requests, windows, package_recheck = reconstruct_package(package, package_manifest_sha256)
    inputs = Inputs()
    association_ref = {"path": str(safe_path(responses)), "sha256": responses_sha256}
    association = inputs.obj(association_ref)
    require(set(association) == {"schema_version", "responses"} and type(association["schema_version"]) is int
            and association["schema_version"] == 1 and type(association["responses"]) is list,
            "invalid_response_association_schema")
    by_case, selected = {}, {row["case_id"] for row in requests}
    for row in association["responses"]:
        require(type(row) is dict and set(row) ==
                {"case_id", "request_body_sha256", "raw_response", "http_status", "response_complete"},
                "invalid_response_association_shape")
        cid = identity(row["case_id"])
        require(cid in selected, "unknown_response_case")
        require(cid not in by_case, "duplicate_response_case")
        require(type(row["request_body_sha256"]) is str and V.SHA.fullmatch(row["request_body_sha256"]),
                "invalid_request_body_pin")
        pin_shape(row["raw_response"])
        by_case[cid] = row
    results, outputs = [], {}
    for number, request in enumerate(requests, 1):
        cid = request["case_id"]
        result = {**request, "error_codes": [], "propositions": [], "provenance": [],
                  "contract_version": L.CONTRACT_VERSION,
                  "status": "unattempted", "pending_independent_verification": False}
        if cid in by_case:
            row, errors = by_case[cid], result["error_codes"]
            if row["request_body_sha256"] != request["request_body_sha256"]:
                errors.append("request_body_association_mismatch")
            if type(row["http_status"]) is not int or row["http_status"] != 200:
                errors.append("http_status_not_200_integer")
            if row["response_complete"] is not True:
                errors.append("response_not_complete")
            result["status"] = "rejected"
            try:
                raw = inputs.read(row["raw_response"])
                result["raw_response"] = row["raw_response"]
                filename = f"raw_response_{number:04d}.bin"
                outputs[filename] = raw
                result["raw_response_copy"] = filename
                content, observed = V.envelope(raw, prep["request_plan"]["model"])
                result["observed_response"] = observed
                normalized = L.normalize_payload(content, windows[cid])
                if not errors:
                    result.update(propositions=normalized["propositions"], provenance=normalized["provenance"],
                                  status="pending_independent_verification", pending_independent_verification=True)
            except (ValueError, OSError, TypeError, KeyError, UnicodeError, RecursionError) as error:
                errors.append(error_code(error))
        results.append(result)
    counts = {status: sum(row["status"] == status for row in results) for status in
              ("unattempted", "rejected", "pending_independent_verification")}
    counts.update(selected=len(requests), attempted=len(by_case), errors=sum(len(row["error_codes"]) for row in results),
                  normalized_propositions=sum(len(row["propositions"]) for row in results))
    outputs["case_results.jsonl"] = b"".join(canonical_bytes(row) + b"\n" for row in results)
    report = {"experiment_version": VERSION, "schema_version": 1, "package": str(safe_path(package)),
        "package_manifest_sha256": package_manifest_sha256, "response_association": association_ref,
        "approved_identity_manifest": prep["approved_identity_manifest"], "authorization": prep["authorization"],
        "approved_binding_index": prep["approved_binding_index"], "source_hash_policy": SOURCE_POLICY,
        "counts": counts, "all_selected_cases_normalized": counts["pending_independent_verification"] == len(requests),
        "batch_accepted": False, "scope": "selected_cases_and_pinned_source_snapshots_only",
        "unattempted_case_ids": [row["case_id"] for row in results if row["status"] == "unattempted"],
        "case_errors": [{"case_id": row["case_id"], "error_codes": row["error_codes"]} for row in results if row["error_codes"]],
        "association_is_remote_execution_proof": False,
        "reasoning_policy": "No generator reasoning is used or copied into candidate records or verifier requests.",
        "input_hash_inventory": inputs.inventory(), **BOUNDARIES}
    outputs["acceptance_report.json"] = canonical_bytes(report) + b"\n"
    outputs["acceptance_manifest.json"] = canonical_bytes({"experiment_version": VERSION, "schema_version": 1,
        "package_manifest_sha256": package_manifest_sha256, "response_association": association_ref,
        "output_file_hashes": {name: digest(data) for name, data in outputs.items()}, **BOUNDARIES}) + b"\n"

    def recheck():
        inputs.recheck()
        package_recheck()

    publish(out, outputs, materialize, recheck)
    return {"dry_run": not materialize, "report": report,
            "acceptance_manifest_sha256": digest(outputs["acceptance_manifest.json"]), **BOUNDARIES}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    prep = modes.add_parser("prepare")
    prep.add_argument("--selection", required=True)
    prep.add_argument("--selection-sha256", required=True)
    acceptance = modes.add_parser("accept")
    acceptance.add_argument("--package", required=True)
    acceptance.add_argument("--package-manifest-sha256", required=True)
    acceptance.add_argument("--responses", required=True)
    acceptance.add_argument("--responses-sha256", required=True)
    for mode in (prep, acceptance):
        mode.add_argument("--out-dir", required=True, help="absolute absent directory with existing parent")
        mode.add_argument("--materialize", action="store_true")
    args = vars(parser.parse_args(argv))
    mode = args.pop("mode")
    try:
        result = (prepare if mode == "prepare" else accept)(**args)
    except (ValueError, OSError, TypeError, KeyError, UnicodeError, RecursionError) as error:
        print("FAIL: " + error_code(error), file=sys.stderr)
        return 2
    print(canonical_bytes(result).decode("ascii"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
