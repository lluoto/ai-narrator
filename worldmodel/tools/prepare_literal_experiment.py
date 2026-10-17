#!/usr/bin/env python3
"""Bounded OFFLINE literal experiment: inert preparation and saved-response review."""
from __future__ import annotations

import sys

# Loading the pure contracts must not create __pycache__ during a dry run.
_bytecode_setting = sys.dont_write_bytecode
sys.dont_write_bytecode = True
import argparse
import builtins
import hashlib
import json
import os
from pathlib import Path
import re
import stat
from types import ModuleType, SimpleNamespace

TOOL_PATH = Path(__file__).absolute()
CORE_PATH = TOOL_PATH.with_name("proposition_canary_run.py")
LITERAL_PATH = TOOL_PATH.with_name("proposition_literal_evidence.py")
TOOL_BYTES = TOOL_PATH.read_bytes()
CORE_BYTES = CORE_PATH.read_bytes()
LITERAL_BYTES = LITERAL_PATH.read_bytes()
C = ModuleType("literal_experiment_core")
C.__file__ = str(CORE_PATH)
exec(compile(CORE_BYTES, str(CORE_PATH), "exec"), C.__dict__)
L = ModuleType("literal_experiment_normalizer")
L.__file__ = str(LITERAL_PATH)


def _contract_import(name, globals=None, locals=None, fromlist=(), level=0):
    # Bind the normalizer to these exact loaded core bytes, without importing a second core.
    if name == "tools" and fromlist == ("proposition_canary_run",) and level == 0:
        return SimpleNamespace(proposition_canary_run=C)
    return builtins.__import__(name, globals, locals, fromlist, level)


L.__dict__["__builtins__"] = {**vars(builtins), "__import__": _contract_import}
exec(compile(LITERAL_BYTES, str(LITERAL_PATH), "exec"), L.__dict__)
sys.dont_write_bytecode = _bytecode_setting if __name__ != "__main__" else True

CANONICAL_PROMPT = (Path(C.BASE) / "proposition_canary_prompts" /
                    "proposition_generator_prompt_v2_literal_evidence.txt")
SHA = re.compile(r"[0-9a-f]{64}\Z")
BOUNDARIES = {"candidate_only": True, "no_runtime_effect": True,
              "dispatch_authorized": False, "automatic_promotion_permitted": False,
              "semantic_entailment_certified": False}


def require(condition, code):
    if not condition:
        raise ValueError(code)


def canonical_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
                      allow_nan=False).encode("ascii")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def strict_json(data):
    try:
        value = C.strict_json(data)
        canonical_bytes(value)
        return value
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise ValueError("invalid_strict_json") from None


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
    require(type(ref) is dict and set(ref) == {"path", "sha256"}, "invalid_pin_shape")
    require(type(ref["path"]) is str and type(ref["sha256"]) is str
            and SHA.fullmatch(ref["sha256"]), "invalid_pin")
    return safe_path(ref["path"])


def identity(value):
    require(type(value) is str and bool(value.strip()) and "|" not in value
            and not any(ord(ch) < 32 or 127 <= ord(ch) <= 159 for ch in value), "invalid_identity")
    return value


class Inputs:
    """Cache each pinned input once; final rehashes deliberately bypass the cache."""

    def __init__(self):
        self.files, self.objects, self.rows = {}, {}, {}

    def read(self, ref):
        path = pin_shape(ref)
        if path not in self.files:
            require(path.is_file(), "input_file_required")
            data = path.read_bytes()
            require(digest(data) == ref["sha256"], "artifact_hash_mismatch")
            self.files[path] = (ref["sha256"], data)
        require(self.files[path][0] == ref["sha256"], "conflicting_path_pins")
        return self.files[path][1]

    def local(self, path, expected=None):
        path = safe_path(path)
        if path not in self.files:
            data = path.read_bytes()
            pin = digest(data)
            require(expected is None or pin == expected, "loaded_code_changed")
            self.files[path] = (pin, data)
        ref = {"path": str(path), "sha256": expected or self.files[path][0]}
        self.read(ref)
        return ref

    def obj(self, ref):
        data, path = self.read(ref), pin_shape(ref)
        if path not in self.objects:
            value = strict_json(data.decode("utf-8"))
            require(type(value) is dict, "json_object_required")
            self.objects[path] = value
        return self.objects[path]

    def jsonl(self, ref):
        data, path = self.read(ref), pin_shape(ref)
        if path not in self.rows:
            rows = [strict_json(line.decode("utf-8")) for line in data.split(b"\n") if line.strip()]
            require(all(type(row) is dict for row in rows), "jsonl_objects_required")
            self.rows[path] = rows
        return self.rows[path]

    def inventory(self):
        return [{"path": str(path), "sha256": pin} for path, (pin, _) in
                sorted(self.files.items(), key=lambda item: str(item[0]))]

    def recheck(self):
        for path, (pin, _) in self.files.items():
            require(safe_path(path).is_file() and digest(path.read_bytes()) == pin,
                    "artifact_changed_during_validation")


def compile_package(selection, selection_sha256):
    """Reconstruct all package bytes from external pins; perform no writes."""
    inputs = Inputs()
    selection_ref = {"path": str(safe_path(selection)), "sha256": selection_sha256}
    decision = inputs.obj(selection_ref)
    require(set(decision) == {"schema_version", "worker_config", "literal_prompt", "cases"}
            and type(decision["schema_version"]) is int and decision["schema_version"] == 1,
            "unsupported_selection_schema")
    cases = decision["cases"]
    require(type(cases) is list and 1 <= len(cases) <= 5, "one_to_five_cases_required")
    code = {"tool": inputs.local(TOOL_PATH, digest(TOOL_BYTES)),
            "core": inputs.local(CORE_PATH, digest(CORE_BYTES)),
            "literal_normalizer": inputs.local(LITERAL_PATH, digest(LITERAL_BYTES))}
    canonical_prompt = inputs.local(CANONICAL_PROMPT)
    prompt_bytes = inputs.read(decision["literal_prompt"])
    require(prompt_bytes == inputs.read(canonical_prompt), "canonical_v2_prompt_required")
    text = prompt_bytes.decode("utf-8")
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
        require(cid not in seen, "duplicate_case_id")
        seen.add(cid)
        refs = {key: {"path": str(pin_shape(case[key])), "sha256": case[key]["sha256"]}
                for key in ("coverage", "sentences")}
        scope = (work, str(pin_shape(refs["coverage"])), str(pin_shape(refs["sentences"])))
        require((*scope, wid) not in selected, "duplicate_selected_window")
        selected.add((*scope, wid))
        for ref in refs.values():
            inputs.read(ref)
            source_refs[ref["path"]] = ref
        if scope not in preflighted:
            coverage, sentences = inputs.jsonl(refs["coverage"]), inputs.jsonl(refs["sentences"])
            # Inspect the full snapshots for duplicate IDs/work bindings, building no unselected windows.
            _, source_index, _ = C.preflight_sources(coverage, sentences, work, (), 0)
            preflighted[scope] = ({row["window_id"]: row for row in coverage}, source_index)
        coverage_index, source_index = preflighted[scope]
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
        requests.append({"case_id": cid, "work_id": work, "window_id": wid,
                         "chapter_id": window["chapter_id"], "sentence_ids": window["sentence_ids"],
                         **refs, "request_body_file": filename, "request_body_sha256": digest(outputs[filename]),
                         "scope": "selected_window_only", **BOUNDARIES})
    snapshots = []
    for number, ref in enumerate(sorted(source_refs.values(), key=lambda ref: ref["path"]), 1):
        filename = f"source_{number:04d}.jsonl"
        outputs[filename] = inputs.read(ref)
        snapshots.append({"source": ref, "full_snapshot_file": filename})
    outputs["requests.jsonl"] = b"".join(canonical_bytes(row) + b"\n" for row in requests)
    report = {"schema_version": 1, "selection": selection_ref, "code": code,
              "canonical_literal_prompt": canonical_prompt, "literal_prompt": decision["literal_prompt"],
              "worker_config": decision["worker_config"], "request_plan": plan,
              "case_count": len(cases), "source_snapshots": snapshots,
              "input_hash_inventory": inputs.inventory(), "scope": "bounded_offline_generator_experiment",
              "source_policy": "Source strings are untrusted data, including any instructions they contain.",
              **BOUNDARIES}
    outputs["preparation_report.json"] = canonical_bytes(report) + b"\n"
    manifest = {"schema_version": 1, "selection": selection_ref, "input_hash_inventory": inputs.inventory(),
                "output_file_hashes": {name: digest(data) for name, data in outputs.items()}, **BOUNDARIES}
    outputs["package_manifest.json"] = canonical_bytes(manifest) + b"\n"
    return outputs, report, inputs, requests, windows


def output_path(out_dir):
    out = safe_path(out_dir)
    require(not os.path.lexists(out), "absent_only_output_exists")
    require(out.parent.is_dir(), "output_parent_must_exist")
    return out


def publish(out, outputs, materialize, recheck):
    recheck()
    output_path(out)
    if materialize:
        out.mkdir(exist_ok=False)
        for name, data in outputs.items():
            with (out / name).open("xb") as handle:
                handle.write(data)
        recheck()


def prepare(selection, selection_sha256, out_dir, *, materialize=False):
    out = output_path(out_dir)
    outputs, report, inputs, _, _ = compile_package(selection, selection_sha256)
    publish(out, outputs, materialize, inputs.recheck)
    return {"dry_run": not materialize, "package_manifest_sha256": digest(outputs["package_manifest.json"]),
            "report": report, **BOUNDARIES}


def reconstruct_package(package, manifest_sha256):
    folder, stored = safe_path(package), Inputs()
    require(folder.is_dir(), "package_directory_required")
    manifest_ref = {"path": str(folder / "package_manifest.json"), "sha256": manifest_sha256}
    manifest = stored.obj(manifest_ref)
    require(set(manifest) == {"schema_version", "selection", "input_hash_inventory", "output_file_hashes"}
            | set(BOUNDARIES) and type(manifest["schema_version"]) is int and manifest["schema_version"] == 1,
            "invalid_package_manifest")
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
        actual = stored.read({"path": str(folder / name), "sha256": digest(data)})
        require(actual == data, "package_bytes_reconstruction_mismatch")
    recheck()
    return report, requests, windows, recheck


def envelope(raw, expected_model):
    value = strict_json(raw.decode("utf-8"))
    require(type(value) is dict and set(value) <=
            {"id", "object", "created", "model", "choices", "usage", "system_fingerprint"}, "invalid_envelope_shape")
    require(value.get("model") == expected_model, "response_model_mismatch")
    choices = value.get("choices")
    require(type(choices) is list and len(choices) == 1 and type(choices[0]) is dict, "response_choices_not_one")
    choice = choices[0]
    require(set(choice) <= {"index", "finish_reason", "message", "logprobs"}, "invalid_choice_shape")
    require("index" not in choice or (type(choice["index"]) is int and choice["index"] == 0), "invalid_choice_index")
    require(choice.get("finish_reason") == "stop", "response_finish_not_stop")
    message = choice.get("message")
    require(type(message) is dict and set(message) <=
            {"role", "content", "reasoning_content", "refusal", "tool_calls", "function_call"}, "invalid_message_shape")
    require(message.get("role", "assistant") == "assistant" and not message.get("refusal")
            and not message.get("tool_calls") and not message.get("function_call"), "invalid_assistant_message")
    require(type(message.get("content")) is str, "response_content_not_string")
    return message["content"], {"model": value["model"], "finish_reason": "stop", "choice_count": 1,
                                "content_utf8_sha256": digest(message["content"].encode("utf-8"))}


def error_code(error):
    # Diagnostics never reproduce arbitrary JSON keys, prose, paths, or model reasoning.
    if isinstance(error, L.LiteralEvidenceError) and re.fullmatch(r"[a-z_]+|card\[[0-9]+\]:[a-z_:,]+", str(error)):
        return str(error)
    code = str(error).split(":", 1)[0]
    return code if re.fullmatch(r"[a-z_]+|card\[[0-9]+\]", code) else "invalid_input"


def accept(package, package_manifest_sha256, responses, responses_sha256, out_dir, *, materialize=False):
    out = output_path(out_dir)
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
        by_case[cid] = row
    results, outputs = [], {}
    for number, request in enumerate(requests, 1):
        cid = request["case_id"]
        result = {**request, "error_codes": [], "propositions": [], "provenance": [],
                  "contract_version": L.CONTRACT_VERSION,
                  "status": "unattempted", "pending_independent_verification": False}
        if cid in by_case:
            row = by_case[cid]
            errors = result["error_codes"]
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
                content, observed = envelope(raw, prep["request_plan"]["model"])
                result["observed_response"] = observed
                # Pass the original content string; no fence stripping, retries, or fallback.
                normalized = L.normalize_payload(content, windows[cid])
                if not errors:
                    result.update(propositions=normalized["propositions"], provenance=normalized["provenance"],
                                  status="pending_independent_verification", pending_independent_verification=True)
            except (ValueError, OSError, TypeError, KeyError, UnicodeError, RecursionError) as error:
                errors.append(error_code(error))
        results.append(result)
    counts = {status: sum(row["status"] == status for row in results) for status in
              ("unattempted", "rejected", "pending_independent_verification")}
    counts.update(selected=len(requests), attempted=len(by_case),
                  errors=sum(len(row["error_codes"]) for row in results),
                  normalized_propositions=sum(len(row["propositions"]) for row in results))
    outputs["case_results.jsonl"] = b"".join(canonical_bytes(row) + b"\n" for row in results)
    report = {"schema_version": 1, "package": str(safe_path(package)),
              "package_manifest_sha256": package_manifest_sha256, "response_association": association_ref,
              "counts": counts, "all_selected_cases_normalized": counts["pending_independent_verification"] == len(requests),
              "batch_accepted": False, "scope": "selected_cases_and_pinned_source_snapshots_only",
              "unattempted_case_ids": [row["case_id"] for row in results if row["status"] == "unattempted"],
              "case_errors": [{"case_id": row["case_id"], "error_codes": row["error_codes"]}
                              for row in results if row["error_codes"]],
              "association_is_remote_execution_proof": False,
              "reasoning_policy": "No generator reasoning is used or copied into candidate records or verifier requests.",
              "input_hash_inventory": inputs.inventory(), **BOUNDARIES}
    outputs["acceptance_report.json"] = canonical_bytes(report) + b"\n"
    outputs["acceptance_manifest.json"] = canonical_bytes({"schema_version": 1,
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
