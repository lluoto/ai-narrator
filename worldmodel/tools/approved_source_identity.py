#!/usr/bin/env python3
"""Offline, absent-only data identity authorization; never changes source rows.

This is a new declaration based on explicit user approval, not historical mapping
recovery or human source review. A derived/deduplicated source hash is NOT covered.
No imports from the strict validator, execution of prior scripts, or model calls.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from types import MappingProxyType

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "runs/_extraction_scheduler/20260924"
NAMESPACE = BASE / "source_namespace_binding_audit_v2/manifest.json"
INVENTORY = BASE / "generation_followup_inventory_v2/manifest.json"
OUT = BASE / "source_identity_bindings_approved_v1"
NAMESPACE_SHA256 = "479bb2e590e9c6d3a96dd320a547052beb06c00c45e4a038b335413a978ca04d"
INVENTORY_SHA256 = "b7aecb1f7009cb6353356fdff0de7ba5575965179f6bd4abb0652544f24c55da"
EXCLUDED_WORK = "\u7f51\u6e38\u4e4b\u5c04\u7834\u82cd\u7a79"
VERSION = "approved_source_identity.v1"
KEY_FIELDS = ("named_work_id", "full_original_sentence_file_sha256", "local_work_id")
APPROVAL = {
    "approval_basis": "explicit_user_instruction",
    "approval_text": "1\uff0c2\u6279\u51c6",
    "executed_by": "assistant",
    "decision_scope": "data_identity_only",
}
COUNTS = {"approved_bindings": 83, "approved_works": 83,
          "covered_deferred_windows": 2186, "excluded_works": 1,
          "excluded_deferred_windows": 47}
BOUNDARIES = {
    "source_rows_unmodified": True, "global_B001_alias": False,
    "historical_mapping_recovered": False, "human_source_review_claimed": False,
    "human_gold": False, "tier_changed": False, "publication_authorized": False,
    "runtime_rules_changed": False, "dispatch_authorized": False,
    "automatic_regeneration": False, "new_source_snapshot_created": False,
    "generation_output_created": False, "strict_core_modified": False,
    "model_calls": 0, "network_calls": 0,
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, indent=2,
                       allow_nan=False) + "\n").encode("utf-8")


def strict(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate_json_key:" + key)
            result[key] = value
        return result

    def constant(value):
        raise ValueError("nonfinite_json:" + value)

    return json.loads(data, object_pairs_hook=pairs, parse_constant=constant)


class Inputs:
    """Hash exact bytes and guard metadata before/after reads and final rehash."""

    def __init__(self):
        self.observed = {}
        self.metadata = {}
        self.paths = {}
        self.checked_parents = set()

    def path(self, text):
        if str(text) in self.paths:
            return self.paths[str(text)]
        path = Path(text)
        require(".." not in path.parts, "unsafe_path")
        if not path.is_absolute():
            path = ROOT / path
        path = path.absolute()
        require(path.is_relative_to(ROOT), "path_outside_root:" + str(path))
        for node in (path, *path.parents):
            if node in self.checked_parents:
                continue
            require(not node.is_symlink(), "symlink_or_junction")
            if node.exists():
                require(not (getattr(node.lstat(), "st_file_attributes", 0) & 0x400),
                        "symlink_or_junction")
            if node != path:
                self.checked_parents.add(node)
        self.paths[str(text)] = path
        return path

    @staticmethod
    def stamp(path):
        stat = path.stat()
        return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)

    def verify(self, ref):
        require(isinstance(ref, dict) and isinstance(ref.get("path"), str)
                and isinstance(ref.get("sha256"), str)
                and re.fullmatch(r"[0-9a-f]{64}", ref["sha256"]), "invalid_file_pin")
        path = self.path(ref["path"])
        key = path.as_posix()
        if key not in self.observed:
            before = self.stamp(path)
            digest, size = hashlib.sha256(), 0
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
                    size += len(chunk)
            require(before == self.stamp(path), "metadata_changed_during_read:" + key)
            self.observed[key] = {"path": key, "sha256": digest.hexdigest(), "bytes": size}
            self.metadata[key] = before
        pin = self.observed[key]
        require(pin["sha256"] == ref["sha256"], "input_hash_mismatch:" + key)
        require("bytes" not in ref or type(ref["bytes"]) is int
                and ref["bytes"] == pin["bytes"], "input_size_mismatch:" + key)
        require(self.stamp(path) == self.metadata[key], "metadata_changed_after_read:" + key)
        return dict(pin)

    def read(self, ref):
        pin = self.verify(ref)
        path = self.path(pin["path"])
        data = path.read_bytes()
        require(sha(data) == pin["sha256"], "input_changed_before_parse")
        require(self.stamp(path) == self.metadata[pin["path"]], "metadata_changed_before_parse")
        return data

    def load(self, ref):
        return strict(self.read(ref))

    def recheck(self):
        # Rehash all observed files, including all 83 approved original sources.
        fresh = Inputs()
        for key, pin in self.observed.items():
            require(self.stamp(self.path(key)) == self.metadata[key], "final_metadata_changed:" + key)
            require(fresh.verify(pin) == pin, "final_hash_changed:" + key)
            require(self.stamp(self.path(key)) == self.metadata[key], "final_metadata_changed:" + key)


def output_refs(directory, manifest):
    result = {}
    for name, pin in manifest["outputs"].items():
        require(Path(name).name == name and name not in (".", "..", "manifest.json"),
                "unsafe_output_name")
        require(set(pin) == {"sha256", "bytes"}, "invalid_output_pin")
        result[name] = {"path": (directory / name).as_posix(), **pin}
    return result


def record_schema():
    pin = {"type": "object", "additionalProperties": False,
           "required": ["path", "sha256", "bytes"], "properties": {
               "path": {"type": "string", "minLength": 1},
               "sha256": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
               "bytes": {"type": "integer", "minimum": 0}}}
    def evidence_ref(location, value):
        return {"type": "object", "additionalProperties": False,
                "required": list(pin["required"]) + [location] + list(value),
                "properties": {**pin["properties"], location: {"type": "string", "minLength": 1}, **value}}

    evidence_properties = {
        "namespace_manifest": {"$ref": "#/$defs/pin"},
        "inventory_manifest": {"$ref": "#/$defs/pin"},
        "per_work": {"type": "object", "additionalProperties": False,
                     "required": list(pin["required"]) + ["line", "row_sha256"], "properties": {
                         **pin["properties"], "line": {"type": "integer", "minimum": 1},
                         "row_sha256": pin["properties"]["sha256"]}},
        "proposal": evidence_ref("pointer", {"approved_in_original": {"const": False}}),
        "metadata_inventory": evidence_ref("pointer", {}),
        "metadata_refs": {"type": "array", "items": {"$ref": "#/$defs/pin"}},
        "original_status": {"const": "mapping_candidate_needs_approval"},
        "lineage_fully_confirmed": {"type": "boolean"},
        "declared_metadata_namespace_relation": {"type": "string"},
    }
    properties = {
        "schema": {"const": VERSION + ".binding"},
        "key": {"type": "object", "additionalProperties": False,
                "required": list(KEY_FIELDS), "properties": {
                    "named_work_id": {"type": "string", "minLength": 1},
                    "full_original_sentence_file_sha256": pin["properties"]["sha256"],
                    "local_work_id": {"const": "B001"}}},
        "approved": {"const": True}, "authorization": {"$ref": "#/$defs/pin"},
        "source": {"$ref": "#/$defs/pin"},
        "artifacts": {"type": "object", "additionalProperties": False,
                      "required": ["coverage", "generator", "job"], "properties": {
                          k: {"$ref": "#/$defs/pin"} for k in ("coverage", "generator", "job")}},
        "source_row_count": {"type": "integer", "minimum": 1},
        "source_line_ranges": {"type": "array", "minItems": 1, "items": {
            "type": "array", "minItems": 2, "maxItems": 2,
            "items": {"type": "integer", "minimum": 1}}},
        "selected_row_count": {"type": "integer", "minimum": 0},
        "covered_deferred_window_count": {"type": "integer", "minimum": 1},
        "namespace_evidence": {"type": "object", "additionalProperties": False,
                               "required": list(evidence_properties), "properties": evidence_properties},
        "boundaries": {"const": BOUNDARIES},
        **{k: {"const": v} for k, v in APPROVAL.items()},
    }
    return {"$schema": "https://json-schema.org/draft/2020-12/schema",
            "title": VERSION + ".binding", "type": "object", "additionalProperties": False,
            "required": list(properties), "properties": properties, "$defs": {"pin": pin},
            "$comment": "Exact evidence and authorization are additionally checked by load_approved_bindings."
            " No derived/deduplicated source hashes or global B001 aliases are authorized."}


def build(namespace_path=NAMESPACE, inventory_path=INVENTORY, *, verify_sources=True):
    inputs = Inputs()
    namespace_ref = {"path": inputs.path(namespace_path).as_posix(), "sha256": NAMESPACE_SHA256}
    inventory_ref = {"path": inputs.path(inventory_path).as_posix(), "sha256": INVENTORY_SHA256}
    namespace = inputs.load(namespace_ref)
    inventory = inputs.load(inventory_ref)
    require(namespace["version"] == "source_namespace_binding_audit_v2.0", "namespace_schema")
    require(namespace["inventory"] == inventory_ref, "inventory_pin_disagrees")
    ns_refs = output_refs(inputs.path(namespace_path).parent, namespace)
    require(set(ns_refs) == {"per_work_bindings.jsonl", "mapping_proposals.json",
                             "metadata_inventory.json", "report.json", "report.md"}, "namespace_output_set")
    for ref in list(ns_refs.values()) + list(output_refs(inputs.path(inventory_path).parent, inventory).values()):
        inputs.verify(ref)
    evidence_bytes = inputs.read(ns_refs["per_work_bindings.jsonl"])
    evidence = [(line, strict(raw), sha(raw.rstrip(b"\r\n")))
                for line, raw in enumerate(evidence_bytes.splitlines(keepends=True), 1) if raw.strip()]
    proposals = inputs.load(ns_refs["mapping_proposals.json"])
    report = inputs.load(ns_refs["report.json"])
    metadata = inputs.load(ns_refs["metadata_inventory.json"])
    require(proposals["proposal_only"] is True and len(proposals["bindings"]) == 84, "proposal_scope")
    require(len(evidence) == 84 and len({e["work_id"] for _, e, _ in evidence}) == 84, "evidence_scope")
    expected_counts = {"mapping_candidate_needs_approval": {"works": 83, "windows": 2186},
                       "unresolved": {"works": 1, "windows": 47},
                       "conflicting_identity": {"works": 0, "windows": 0},
                       "supported_local_namespace_mapping": {"works": 0, "windows": 0}}
    require(report["counts"] == expected_counts, "namespace_counts")
    source_paths = {e["artifacts"]["sentences"]["path"] for _, e, _ in evidence}
    declared = {}
    for ref in namespace["inputs"]:
        require(ref["path"] not in declared, "duplicate_input_pin")
        declared[ref["path"]] = ref
        if verify_sources or ref["path"] not in source_paths:
            inputs.verify(ref)
    inputs.verify(namespace["metadata_inventory"])
    require(namespace["metadata_inventory"]["sha256"] == ns_refs["metadata_inventory.json"]["sha256"],
            "metadata_inventory_pin_disagrees")
    metadata_by_work = {e["work_id"]: (i, e) for i, e in enumerate(metadata["works"])}
    require(len(metadata_by_work) == 84 and set(metadata_by_work) == {e["work_id"] for _, e, _ in evidence},
            "metadata_scope")
    proposal_by_work = {}
    for i, proposal in enumerate(proposals["bindings"]):
        work = proposal["key"]["work_id"]
        require(work not in proposal_by_work, "duplicate_proposal")
        require(proposal["approved"] is False and proposal["applied"] is False
                and proposal["global_alias"] is False, "original_proposal_not_unapproved")
        proposal_by_work[work] = (i, proposal)
    candidates, excluded = [], []
    for line, item, row_sha in evidence:
        work = item["work_id"]
        require(work in proposal_by_work, "missing_proposal")
        proposal_index, proposal = proposal_by_work[work]
        require(item["proposed_bindings"] == [proposal], "proposal_evidence_disagrees")
        source = item["artifacts"]["sentences"]
        key = {"named_work_id": work, "full_original_sentence_file_sha256": source["sha256"],
               "local_work_id": "B001"}
        require(proposal["key"] == {"work_id": work, "source_sha256": source["sha256"],
                                    "local_work_id": "B001"}, "proposal_key_disagrees")
        require(proposal["target_work_id"] == work and proposal["status"] == item["status"], "proposal_target")
        metadata_index, work_metadata = metadata_by_work[work]
        require(work_metadata["source"] == source and work_metadata["metadata"] == item["metadata_refs"],
                "metadata_evidence_disagrees")
        pins = {}
        for name, ref in item["artifacts"].items():
            require(ref["path"] in declared, "artifact_not_in_pinned_inputs")
            pinned = declared[ref["path"]]
            require(pinned["sha256"] == ref["sha256"], "artifact_pin_disagrees")
            pins[name] = dict(pinned)
            if verify_sources or name != "sentences":
                inputs.verify(pinned)
        require(set(pins) == {"sentences", "coverage", "generator", "job"}, "artifact_set")
        for ref in item["metadata_refs"]:
            inputs.verify(ref)
        if work == EXCLUDED_WORK:
            require(item["status"] == "unresolved" and item["deferred_window_count"] == 47, "excluded_scope")
            excluded.append({"named_work_id": work, "status": "unresolved",
                             "deferred_window_count": 47, "source": pins["sentences"]})
            continue
        require(item["status"] == "mapping_candidate_needs_approval" and not item["conflicts"],
                "noncandidate_cannot_be_approved")
        require(item["sentence_distribution"]["observed_work_id_frequencies"] == {"B001": proposal["source_row_count"]},
                "local_namespace_distribution")
        candidates.append({
            "schema": VERSION + ".binding", "key": key, "approved": True, **APPROVAL,
            "source": pins.pop("sentences"), "artifacts": pins,
            "source_row_count": proposal["source_row_count"],
            "source_line_ranges": proposal["source_line_ranges"],
            "selected_row_count": proposal["selected_row_count"],
            "covered_deferred_window_count": item["deferred_window_count"],
            "namespace_evidence": {
                "namespace_manifest": inputs.verify(namespace_ref),
                "inventory_manifest": inputs.verify(inventory_ref),
                "per_work": {**ns_refs["per_work_bindings.jsonl"], "line": line, "row_sha256": row_sha},
                "proposal": {**ns_refs["mapping_proposals.json"], "pointer": f"/bindings/{proposal_index}",
                             "approved_in_original": False},
                "metadata_inventory": {**ns_refs["metadata_inventory.json"], "pointer": f"/works/{metadata_index}"},
                "metadata_refs": item["metadata_refs"], "original_status": item["status"],
                "lineage_fully_confirmed": item["lineage_fully_confirmed"],
                "declared_metadata_namespace_relation": item["declared_metadata_namespace_relation"],
            }, "boundaries": dict(BOUNDARIES),
        })
    candidates.sort(key=lambda r: tuple(r["key"][k] for k in KEY_FIELDS))
    require(len(candidates) == 83 and len(excluded) == 1 and
            sum(r["covered_deferred_window_count"] for r in candidates) == 2186, "approval_scope")
    authorization = {
        "schema": VERSION + ".authorization", **APPROVAL,
        "authority": "user_explicit_approval_new_declaration_not_historical_recovery",
        "proposal_input": ns_refs["mapping_proposals.json"],
        "namespace_manifest": inputs.verify(namespace_ref),
        "inventory_manifest": inputs.verify(inventory_ref),
        "binding_key": list(KEY_FIELDS), "counts": dict(COUNTS), "excluded": excluded,
        "approved_keys_sha256": sha(encoded([r["key"] for r in candidates])),
        "boundaries": dict(BOUNDARIES),
    }
    outputs = {"authorization.json": encoded(authorization)}
    auth_pin = {"path": "authorization.json", "sha256": sha(outputs["authorization.json"]),
                "bytes": len(outputs["authorization.json"])}
    for record in candidates:
        record["authorization"] = dict(auth_pin)
    outputs["approved_bindings.jsonl"] = b"".join(
        json.dumps(r, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
        + b"\n" for r in candidates)
    outputs["binding_schema.json"] = encoded(record_schema())
    outputs["report.json"] = encoded({
        "schema": VERSION + ".report", "counts": dict(COUNTS), "authorization": auth_pin,
        "excluded": excluded, "approved_source_files": 83,
        "approved_source_bytes": sum(r["source"]["bytes"] for r in candidates),
        "approved_source_rows": sum(r["source_row_count"] for r in candidates),
        "source_verification_policy": "full_file_sha256_and_stable_metadata_before_output_and_final_rehash",
        "approval_meaning": "New data identity declaration only; not human source review or historical mapping proof.",
        "derived_source_policy": "A derived/deduplicated hash requires a separate authorization; no fallback.",
        "boundaries": dict(BOUNDARIES),
    })
    outputs["README.md"] = (
        "# Approved Source Identity V1\n\n"
        "83 exact bindings / 83 original source files / 2186 deferred windows. "
        "One unresolved work (47 windows) is excluded. No automatic regeneration or release.\n\n"
        "Authorization is a new user-approved data identity declaration, not recovery of historical "
        "mapping, human source review, human gold, tier/publication approval, or dispatch authority. "
        "The original approved=false proposals remain unchanged.\n\n"
        "## Consumer API\n\n"
        "`from tools.approved_source_identity import load_approved_bindings, validate_local_identity`\n\n"
        "`bindings = load_approved_bindings(manifest_path, manifest_sha256)` requires an external "
        "full manifest SHA256. It verifies schema, authorization, all output pins, original pinned "
        "evidence and current original source bytes, with final full rehash and metadata stability. "
        "The returned mapping and every nested record are read-only (lists become tuples). "
        "`verify_sources=False` explicitly skips current source checks, for metadata-only inspection; "
        "it must not be used as a current source integrity attestation.\n\n"
        "`validate_local_identity(bindings, work_id=title, source_sha256=full_original_file_hash, "
        "local_work_id='B001')` returns True only for the exact tuple, otherwise raises ValueError. "
        "It performs no I/O and does not rewrite the source record. Consumers must bind the hash "
        "to the actual file they read; a loaded map is a point-in-time check, not a live file lock.\n\n"
        "## Schema\n\n"
        "See `binding_schema.json`. Key order: `(named_work_id, "
        "full_original_sentence_file_sha256, local_work_id)`. `source` pins the complete original "
        "sentence file; `artifacts` pins coverage/generator/job. `namespace_evidence` contains "
        "manifest pins, exact JSONL line/hash, proposal/metadata JSON pointers and metadata pins. "
        "`authorization` links each binding to the immutable declaration. The manifest pins all "
        "products, including authorization and schema, but has no self-hash.\n\n"
        "No global B001 alias, title normalization, path search, silent source fallback, source copy, "
        "or generated model output exists here. A derived or deduplicated source SHA256 is not "
        "automatically covered, even if its title/local ID is identical. This helper is separate "
        "from the unchanged strict core; integration must explicitly opt into this source scope.\n"
    ).encode("ascii")
    manifest = {
        "schema": VERSION + ".manifest", "binding_key": list(KEY_FIELDS), "counts": dict(COUNTS),
        "authorization": auth_pin, "boundaries": dict(BOUNDARIES),
        "inputs": {"namespace_manifest": inputs.verify(namespace_ref),
                   "inventory_manifest": inputs.verify(inventory_ref)},
        "outputs": {name: {"sha256": sha(data), "bytes": len(data)} for name, data in outputs.items()},
        "materialization": "absent_only_exclusive_create_manifest_last",
    }
    outputs["manifest.json"] = encoded(manifest)
    inputs.recheck()
    return outputs, candidates, inputs


def freeze(value):
    if isinstance(value, dict):
        return MappingProxyType({k: freeze(v) for k, v in value.items()})
    if isinstance(value, list):
        return tuple(freeze(v) for v in value)
    return value


def load_approved_bindings(manifest_path, manifest_sha256, *, verify_sources=True):
    """Return deeply immutable exact-key records after external-pin verification.

    verify_sources=False is metadata-only inspection, NOT current source validation.
    Derived/deduplicated sources require their own binding; never reuse this hash.
    """
    inputs = Inputs()
    manifest_ref = {"path": str(manifest_path), "sha256": manifest_sha256}
    manifest = inputs.load(manifest_ref)
    require(manifest["schema"] == VERSION + ".manifest", "manifest_schema")
    require(manifest["binding_key"] == list(KEY_FIELDS) and manifest["counts"] == COUNTS, "manifest_scope")
    directory = inputs.path(manifest_path).parent
    refs = output_refs(directory, manifest)
    require(set(refs) == {"authorization.json", "approved_bindings.jsonl", "binding_schema.json",
                          "report.json", "README.md"}, "approved_output_set")
    require({p.name for p in directory.iterdir()} == set(refs) | {"manifest.json"}, "unexpected_output_files")
    for ref in refs.values():
        inputs.verify(ref)
    require(manifest["authorization"] == {"path": "authorization.json", **manifest["outputs"]["authorization.json"]},
            "authorization_pin_disagrees")
    auth = inputs.load(refs["authorization.json"])
    require(auth["schema"] == VERSION + ".authorization"
            and all(auth.get(k) == v for k, v in APPROVAL.items()), "authorization_scope")
    records = [strict(raw) for raw in inputs.read(refs["approved_bindings.jsonl"]).splitlines() if raw.strip()]
    result = {}
    for record in records:
        key = tuple(record["key"][k] for k in KEY_FIELDS)
        require(key not in result, "duplicate_binding_key")
        require(record["schema"] == VERSION + ".binding" and record["approved"] is True,
                "binding_schema_or_approval")
        result[key] = freeze(record)
    require(len(result) == 83, "binding_count")
    source_inputs = manifest["inputs"]
    require(source_inputs["namespace_manifest"]["sha256"] == NAMESPACE_SHA256
            and source_inputs["inventory_manifest"]["sha256"] == INVENTORY_SHA256, "authority_input_pins")
    expected, _, evidence_inputs = build(source_inputs["namespace_manifest"]["path"],
                                        source_inputs["inventory_manifest"]["path"], verify_sources=verify_sources)
    # Reproduce the entire declaration, not merely a self-consistent tampered chain.
    for name, data in expected.items():
        ref = manifest_ref if name == "manifest.json" else refs[name]
        require(inputs.read(ref) == data, "declaration_not_reproducible:" + name)
    inputs.recheck()
    evidence_inputs.recheck()
    return MappingProxyType(result)


def validate_local_identity(binding_map, *, work_id, source_sha256, local_work_id):
    """Pure exact-tuple membership check; never edits original sentence records."""
    require(isinstance(work_id, str) and isinstance(source_sha256, str)
            and isinstance(local_work_id, str), "identity_fields_must_be_strings")
    key = (work_id, source_sha256, local_work_id)
    require(key in binding_map, "unapproved_exact_source_identity")
    record = binding_map[key]
    require(record["approved"] is True and tuple(record["key"][k] for k in KEY_FIELDS) == key,
            "invalid_binding_record")
    return True


def materialize(output, outputs, inputs):
    output = inputs.path(output)
    require(output == OUT.absolute(), "output_outside_owned_directory")
    require(not output.exists(), "output_directory_already_exists")
    require(output.parent.is_dir(), "output_parent_missing")
    inputs.recheck()
    output.mkdir()
    for name, data in outputs.items():
        if name != "manifest.json":
            with (output / name).open("xb") as handle:
                handle.write(data)
    # No completed manifest is published if a source changed during output writes.
    inputs.recheck()
    for name, data in outputs.items():
        if name != "manifest.json":
            require((output / name).read_bytes() == data, "output_write_mismatch")
    with (output / "manifest.json").open("xb") as handle:
        handle.write(outputs["manifest.json"])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--materialize", choices=("newabsent",))
    mode.add_argument("--check", action="store_true")
    parser.add_argument("--manifest-sha256", help="external approved manifest pin, required for --check")
    args = parser.parse_args(argv)
    if args.check:
        require(args.manifest_sha256, "external_manifest_pin_required")
        bindings = load_approved_bindings(OUT / "manifest.json", args.manifest_sha256)
        print(json.dumps({"mode": "check", "counts": COUNTS, "bindings_verified": len(bindings),
                          "manifest_sha256": args.manifest_sha256, "model_calls": 0}))
        return
    require(args.manifest_sha256 is None, "manifest_pin_only_for_check")
    if args.materialize:
        require(not OUT.exists(), "output_directory_already_exists")
    outputs, _, inputs = build()
    if args.materialize:
        materialize(OUT, outputs, inputs)
    print(json.dumps({"mode": "materialize" if args.materialize else "dry_run", "counts": COUNTS,
                      "files": len(outputs), "manifest_sha256": sha(outputs["manifest.json"]),
                      "authorization_sha256": sha(outputs["authorization.json"]), "model_calls": 0}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError) as error:
        print("approved_identity_failed: " + str(error), file=sys.stderr)
        sys.exit(1)
