#!/usr/bin/env python3
"""Offline identity-only overlay; never executes a reviewer or the parent runner."""
from __future__ import annotations

import argparse
import ast
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import sys


ROOT = Path(__file__).absolute().parents[1]
SCHEDULER = Path("runs/_extraction_scheduler/20260924")
PARENT = SCHEDULER / "luna_conflict_review_preparation_v1"
OUT = SCHEDULER / "luna_review_identity_policy_v2"
PARENT_PIN = "d530c71a1eb56064ee79ae262404889bc1e498985b4161a8fcca2c536b4e0027"
ORIGINAL_TOOL = Path("tools/prepare_luna_conflict_review.py")
ORIGINAL_TOOL_PIN = "6dc20e4010482e504a7289c740241c78d3b65ba5f2b55f864494cf3ffee7c4a6"
OWN_FILES = ("tools/luna_review_identity_v2.py", "tests/test_luna_review_identity_v2.py")
ACTUAL_EXECUTOR = {"provider": "openai", "model": "gpt-6-luna", "version": None,
                   "version_status": "not_exposed_by_environment"}
JUDGMENTS = ("supported", "insufficient", "contradicted", "needs_context")
ENUMS = {"new_source_judgment": JUDGMENTS,
         "recommendation_only": ("original", "reverify", "neither", "undecided"),
         "support_scope": ("prior_sent_evidence", "new_review_context_only", "both", "none")}
DIMENSIONS = ("source_fidelity", "modality", "temporal", "actor_attribution", "route")
RESPONSE_FIELDS = {"case_id", "reviewer_class", "actual_executor", "new_source_judgment",
                   "abstain", "recommendation_only", "support_scope", "citations", "checks",
                   "public_evidence_summary", "no_runtime_effect"}
# JSON Schema has no portable case-insensitive flag. Use the same pattern in both validators.
VERSION_PLACEHOLDERS = ("null", "unknown", "none", "n/a", "undefined", "unspecified",
                        "unavailable", "not_available", "not_exposed", "not_exposed_by_environment",
                        "gpt-6-luna", "openai/gpt-6-luna")
FORBIDDEN_VERSION = r"^\s*(?:" + "|".join(
    "".join("[" + c.lower() + c.upper() + "]" if c.isalpha() else re.escape(c) for c in word)
    for word in VERSION_PLACEHOLDERS) + r")\s*$"
BOUNDARIES = {"model_calls": 0, "network_calls": 0, "semantic_judgments_performed": 0,
              "no_runtime_effect": True, "effective_pointer_changed": False,
              "human_gold_changed": False, "publication_authorized": False,
              "automatic_promotion_permitted": False, "quality_certified": False,
              "dispatch_authorized": False}


def require(condition, code):
    if not condition:
        raise ValueError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"),
                       allow_nan=False) + "\n").encode("ascii")


def strict(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate_json_key")
            result[key] = value
        return result
    def constant(_):
        raise ValueError("nonfinite_json")
    return json.loads(data, object_pairs_hook=pairs, parse_constant=constant)


def safe_path(root, relative):
    require(isinstance(relative, (str, Path)), "unsafe_path")
    text = str(relative).replace("\\", "/")
    parts = text.split("/")
    require(text and not Path(text).is_absolute() and not text.startswith("/") and
            all(p and p not in (".", "..") and not p.endswith((".", " ")) and
                not any(ord(c) < 32 or ord(c) == 127 or c in '<>:"|?*' for c in p) and
                not re.fullmatch(r"(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", p)
                for p in parts), "unsafe_path")
    path = root.joinpath(*parts)
    for node in (path, *path.parents):
        if os.path.lexists(node):
            require(not node.is_symlink() and
                    not (getattr(node.lstat(), "st_file_attributes", 0) & 0x400), "unsafe_link")
    return path


def validate_executor_v2(executor):
    require(isinstance(executor, dict) and set(executor) == set(ACTUAL_EXECUTOR),
            "actual_executor_fields")
    require(executor["provider"] == "openai" and executor["model"] == "gpt-6-luna",
            "actual_executor_identity")
    version, status = executor["version"], executor["version_status"]
    require((version is None and status == "not_exposed_by_environment") or
            (isinstance(version, str) and bool(version.strip()) and
             re.search(FORBIDDEN_VERSION, version) is None and status == "exposed_by_environment"),
            "actual_executor_version_pair")


def validate_response_v2(value, case):
    """Pure V2 copy of pinned V1 context checks; only executor policy is replaced.

    Malformed objects fail with static ValueError codes rather than leaking input.
    Exposed-version evidence is a caller responsibility, not authenticated here.
    """
    require(isinstance(case, dict) and all(k in case for k in
            ("case_id", "status", "allowed_review_ids")), "case_fields")
    require(isinstance(value, dict) and set(value) == RESPONSE_FIELDS, "response_fields")
    require(value["case_id"] == case["case_id"] and value["reviewer_class"] == "model_delegated"
            and value["no_runtime_effect"] is True, "response_identity")
    validate_executor_v2(value["actual_executor"])
    for field, choices in ENUMS.items():
        require(value[field] in choices, "response_enum")
    require(type(value["abstain"]) is bool and isinstance(value["public_evidence_summary"], str)
            and bool(value["public_evidence_summary"].strip()), "response_summary")
    require(isinstance(value["checks"], list) and isinstance(value["citations"], list), "response_lists")
    for check in value["checks"]:
        require(isinstance(check, dict) and set(check) == {"dimension", "judgment"} and
                check["dimension"] in DIMENSIONS and check["judgment"] in JUDGMENTS, "response_check")
    require(isinstance(case["allowed_review_ids"], list) and all(
        isinstance(r, dict) and isinstance(r.get("review_id"), str) and
        r.get("sent_vs_context") in ("sent", "context") for r in case["allowed_review_ids"]),
        "case_review_ids")
    allowed = {r["review_id"]: r["sent_vs_context"] for r in case["allowed_review_ids"]}
    for cite in value["citations"]:
        require(isinstance(cite, dict) and set(cite) == {"review_id", "sent_vs_context"} and
                isinstance(cite["review_id"], str) and cite["review_id"] in allowed and
                allowed[cite["review_id"]] == cite["sent_vs_context"], "citation_out_of_scope")
    if case["status"] != "reviewable":
        require(value["abstain"] is True and value["new_source_judgment"] == "needs_context" and
                value["recommendation_only"] == "undecided" and value["support_scope"] == "none"
                and not value["citations"] and not value["checks"], "blocked_must_abstain")
    if value["new_source_judgment"] in ("supported", "contradicted"):
        require(bool(value["citations"]), "evidence_required")
    scopes = {c["sent_vs_context"] for c in value["citations"]}
    scope = value["support_scope"]
    require((scope != "prior_sent_evidence" or scopes == {"sent"}) and
            (scope != "new_review_context_only" or scopes == {"context"}) and
            (scope != "both" or scopes == {"sent", "context"}) and
            (scope != "none" or not scopes), "support_scope_mismatch")


def load_original_schema(source):
    """Compile only the pinned pure schema function, not module imports or runner code."""
    require(sha(source) == ORIGINAL_TOOL_PIN, "original_tool_pin_mismatch")
    tree = ast.parse(source, filename=ORIGINAL_TOOL.as_posix())
    functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "response_schema"]
    require(len(functions) == 1, "original_schema_function_missing")
    namespace = {}
    exec(compile(ast.Module(body=functions, type_ignores=[]), ORIGINAL_TOOL.as_posix(), "exec"), namespace)
    return namespace["response_schema"]


def response_schema_v2(original_schema, case_ids):
    schema = copy.deepcopy(original_schema(case_ids))
    schema["properties"]["actual_executor"] = {
        "type": "object", "additionalProperties": False, "required": list(ACTUAL_EXECUTOR),
        "properties": {"provider": {"const": "openai"}, "model": {"const": "gpt-6-luna"},
                       "version": {"type": ["null", "string"]},
                       "version_status": {"enum": ["not_exposed_by_environment", "exposed_by_environment"]}},
        "oneOf": [
            {"properties": {"version": {"type": "null"},
                            "version_status": {"const": "not_exposed_by_environment"}}},
            {"properties": {"version": {"type": "string", "minLength": 1, "pattern": r"\S",
                                        "not": {"pattern": FORBIDDEN_VERSION}},
                            "version_status": {"const": "exposed_by_environment"}}}]}
    return schema


def compile_overlay(root=ROOT):
    root = Path(root).absolute()
    observed = {}

    def read(relative, pin=None, size=None):
        path = safe_path(root, relative)
        data = path.read_bytes()
        digest = sha(data)
        require(pin is None or digest == pin, "input_hash_mismatch")
        require(size is None or len(data) == size, "input_size_mismatch")
        key = path.relative_to(root).as_posix()
        ref = {"path": key, "sha256": digest, "bytes": len(data)}
        require(key not in observed or observed[key] == ref, "input_changed_during_read")
        observed[key] = ref
        return data

    parent = strict(read(PARENT / "manifest.json", PARENT_PIN))
    require(parent["schema"] == "luna_conflict_review_preparation.v1" and
            parent["output_directory"] == (root / PARENT).as_posix() and
            parent["counts"]["status_conflict_rows"] == 713, "parent_package_scope")
    outputs = parent["outputs"]
    require(isinstance(outputs, dict), "parent_outputs_required")
    expected = {"README.md", "executor_registration.json", "prompt.md", "report.json",
                "reviewed_cases.jsonl", "schema_sampler.json", "shard_index.json", "verdict_schema.json"}
    expected.update(s["path"] for s in parent["shards"])
    require(set(outputs) == expected, "parent_output_membership")
    members = list(safe_path(root, PARENT).rglob("*"))
    for path in members:
        safe_path(root, path.relative_to(root))
        require(path.is_file() or path == root / PARENT / "shards", "parent_directory_membership")
    require({p.relative_to(root / PARENT).as_posix() for p in members if p.is_file()} ==
            expected | {"manifest.json"}, "parent_output_membership")
    # Verify all outputs; retain these two temporarily to extract IDs and check schema.
    retained = {}
    for name, ref in sorted(outputs.items()):
        if "path" in ref:
            require(ref["path"] == name, "parent_output_path_mismatch")
        data = read(PARENT / name, ref["sha256"], ref["bytes"])
        if name in ("reviewed_cases.jsonl", "verdict_schema.json"):
            retained[name] = data
    for ref in parent["code_files"]:
        read(ref["path"], ref["sha256"], ref["bytes"])
    original_ref = next(r for r in parent["code_files"] if r["path"] == ORIGINAL_TOOL.as_posix())
    require(original_ref["sha256"] == ORIGINAL_TOOL_PIN, "original_tool_pin_mismatch")
    original_schema = load_original_schema(read(ORIGINAL_TOOL, ORIGINAL_TOOL_PIN))
    case_ids = [strict(line)["case_id"] for line in retained["reviewed_cases.jsonl"].splitlines()]
    require(len(case_ids) == len(set(case_ids)) == 713, "exact_case_membership")
    require(original_schema(case_ids) == strict(retained["verdict_schema.json"]), "parent_schema_mismatch")
    for name in OWN_FILES:
        read(name)
    out = safe_path(root, OUT)
    paths = {name: (out / name).as_posix() for name in
             ("identity_policy.json", "verdict_schema_v2.json", "executor_record_template.json",
              "prompt_addendum.md", "manifest.json")}
    policy = {"schema": "luna_review_identity_policy.v2", "actual_executor": ACTUAL_EXECUTOR,
              "reported_session_identifier": "openai/gpt-6-luna",
              "identity_evidence": "user_report_of_separate_luna_session_environment",
              "transport_verified": False, "independent_version_exposed": False,
              "unknown_version_blocks_review": False, "unknown_version_is_source_uncertainty": False,
              "unknown_version_requires_abstention": False,
              "user_permission": "user permits model review under identifier openai/gpt-6-luna with version not exposed",
              "exposed_version_policy": "Use a real independently exposed environment version only; never invent it or copy the model identifier.",
              "exposed_version_evidence_verified_by_validator": False,
              "caller_trust_boundary": "The pure validator checks identity fields and status pairing, not provenance. A claimed exposed version without actual environment evidence is prohibited; the external execution owner must retain that evidence.",
              "scope": "Identity-only amendment to V1; all semantic, citation, support-scope and blocked-abstention rules remain unchanged.",
              **BOUNDARIES}
    record = {"schema": "luna_executor_record_template.v2", "actual_executor": ACTUAL_EXECUTOR,
              "reviewer_class": "model_delegated", "execution_status": "not_started",
              "identity_evidence": policy["identity_evidence"], "transport_verified": False,
              "actual_review_record_owner": "external_execution_owner_later",
              "actual_review_record": None, "completed_review_count": 0, **BOUNDARIES}
    prompt = f"""# Luna Identity Policy V2 Addendum

Parent manifest: {(root / PARENT / 'manifest.json').as_posix()}
Parent external SHA256: {PARENT_PIN}
Unchanged parent prompt: {(root / PARENT / 'prompt.md').as_posix()}
Unchanged 713 cases: {(root / PARENT / 'reviewed_cases.jsonl').as_posix()}
Unchanged shard index: {(root / PARENT / 'shard_index.json').as_posix()}
Overlay manifest (requires external SHA256): {paths['manifest.json']}
Identity policy: {paths['identity_policy.json']}
Replacement response schema: {paths['verdict_schema_v2.json']}
Executor record template: {paths['executor_record_template.json']}
Pure contextual validator: {(root / OWN_FILES[0]).as_posix()}::validate_response_v2

The user permits model review under identifier openai/gpt-6-luna with version not exposed.
This supersedes only V1's unidentified-executor/nonblank-version requirement and its
request to obtain identity-related permission again. It does not start execution.
The reported separate session identity is not transport-verified by this overlay.
Use actual_executor with EXACTLY provider, model, version, version_status:
{json.dumps(ACTUAL_EXECUTOR, sort_keys=True)}

Unknown version MUST NOT block review, imply source uncertainty or force abstention.
Unknown provider/model are not permitted. If a real separate version is later exposed,
use that nonblank string with version_status=exposed_by_environment. Never use the
model identifier as a version, a placeholder, or the string 'null'. Exposed claims
without actual evidence are prohibited. Validation cannot authenticate that claim;
the external execution owner must retain actual environment evidence and the actual
review record later. The template is not a completed execution or a verdict.

All other V1 semantic fields, source/citation boundaries, support scopes, blocked-case
abstention and no_runtime_effect=true remain unchanged. Use the V2 schema AND pure
context validator, not schema alone. No semantic review is performed by this tool.
No model API, health/process controls, human gold changes, effective results, pointer
changes, quality certification or automatic promotion are created. Keep private
source packets local; this overlay copies no source prose or case decisions.
"""
    products = {"identity_policy.json": encoded(policy),
                "verdict_schema_v2.json": encoded(response_schema_v2(original_schema, case_ids)),
                "executor_record_template.json": encoded(record),
                "prompt_addendum.md": prompt.encode("utf-8")}
    manifest = {"schema": "luna_review_identity_overlay.v2", "output_directory": out.as_posix(),
                "parent_manifest": observed[(PARENT / "manifest.json").as_posix()],
                "original_tool": original_ref, "case_count": 713,
                "input_files": sorted(observed.values(), key=lambda r: r["path"]),
                "code_files": [observed[name] for name in OWN_FILES],
                "outputs": {name: {"path": name, "sha256": sha(data), "bytes": len(data)}
                            for name, data in sorted(products.items())},
                "read_scope": "Pinned parent manifest, every parent output and parent code files; overlay code/tests. No upstream source traversal.",
                "source_prose_copied": False, "parent_modified": False,
                "user_model_review_permission_recorded": True, "authorizations_created": [],
                "materialization": "fixed_path_absent_only_exclusive_create_manifest_last",
                "private_local_only": True, **BOUNDARIES}
    products["manifest.json"] = encoded(manifest)
    return products, manifest


def final_check(root, manifest):
    for ref in manifest["input_files"]:
        data = safe_path(root, ref["path"]).read_bytes()
        require(sha(data) == ref["sha256"] and len(data) == ref["bytes"], "input_changed_final_hash")


def build(root=ROOT, *, materialize=False, check=False, manifest_sha256=None):
    root = Path(root).absolute()
    out = safe_path(root, OUT)
    require(not (materialize and check), "incompatible_modes")
    require(check or manifest_sha256 is None, "manifest_pin_only_for_check")
    if check:
        require(isinstance(manifest_sha256, str) and re.fullmatch(r"[0-9a-f]{64}", manifest_sha256),
                "external_manifest_pin_required")
        require(sha(safe_path(root, OUT / "manifest.json").read_bytes()) == manifest_sha256,
                "manifest_pin_mismatch")
    if materialize:
        require(not os.path.lexists(out), "existing_output_forbidden")
        require(out.parent.is_dir(), "output_parent_required")
    products, manifest = compile_overlay(root)
    pin = sha(products["manifest.json"])
    final_check(root, manifest)
    if check:
        require(pin == manifest_sha256, "reconstructed_manifest_mismatch")
        members = list(out.rglob("*"))
        for path in members:
            safe_path(root, path.relative_to(root))
            require(path.is_file(), "overlay_directory_mismatch")
        require({p.name for p in members} == set(products), "overlay_membership_mismatch")
        for name, data in products.items():
            require(safe_path(root, OUT / name).read_bytes() == data, "output_byte_mismatch")
    elif materialize:
        out.mkdir(exist_ok=False)
        for name, data in products.items():
            with safe_path(root, OUT / name).open("xb") as stream:
                stream.write(data)
    final_check(root, manifest)
    return {"mode": "check" if check else "materialize" if materialize else "dry_run",
            "manifest_sha256": pin, "parent_manifest_sha256": PARENT_PIN,
            "output_directory": out.as_posix(), "case_count": 713, **BOUNDARIES}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--materialize", action="store_true")
    modes.add_argument("--check", action="store_true")
    parser.add_argument("--manifest-sha256")
    args = parser.parse_args(argv)
    try:
        print(encoded(build(materialize=args.materialize, check=args.check,
                            manifest_sha256=args.manifest_sha256)).decode("ascii"), end="")
    except (ValueError, OSError, KeyError, TypeError, StopIteration):
        print("identity_overlay_failed: validation_or_access_error", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
