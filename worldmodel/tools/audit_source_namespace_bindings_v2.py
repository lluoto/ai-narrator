#!/usr/bin/env python3
"""Offline diagnostic supersession of V1; no discovery, remapping or dispatch.

V1 structural verification and streaming helpers execute only from sealed,
hash-verified bytes. V1 files and module globals are never modified. Identity
extraction/qualification below replaces V1's ancestor-union/any-match logic.
Dry run is the default; materialization requires a new absent V2 directory.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import sys
import types

ROOT = Path(__file__).resolve().parents[1]
BASE = Path("runs/_extraction_scheduler/20260924")
OUT = BASE / "source_namespace_binding_audit_v2"
V1_OUT = BASE / "source_namespace_binding_audit_v1"
VERSION = "source_namespace_binding_audit_v2.0"
V1_SCRIPT_SHA256 = "0f2a0e223e5e495131ea26837033eb233f06d96c27dacb8d23eb93c95d26edf9"
V1_MANIFEST_SHA256 = "36fb3f8d92d72a67b9e938f3eedd9d4a0da3bdca291aa27d982aec35f0e8b10d"
POLICY = ("Nearest explicit source declaration shadows ancestors, including malformed declarations. "
          "Within that object, all references must be valid and identical by literal path and SHA256. "
          "Support requires that unique nearest pin to equal the audited source snapshot, plus an exact code/title pair.")
CHAPTER_FILES = {"chapters.jsonl", "chapter_kv.json", "chapters.json"}


def load_v1(path):
    data = Path(path).read_bytes()
    if hashlib.sha256(data).hexdigest() != V1_SCRIPT_SHA256:
        raise ValueError("sealed_v1_implementation_hash_mismatch")
    module = types.ModuleType("sealed_namespace_audit_v1_helpers")
    module.__file__ = str(path)
    # Execute the verified bytes, not a later read or an unpinned import/pyc.
    exec(compile(data, str(path), "exec"), module.__dict__)
    return module


v1 = load_v1(Path(__file__).with_name("audit_source_namespace_bindings.py"))
BOUNDARIES = dict(v1.BOUNDARIES, diagnostic_supersession_only=True,
                  work_remapping_applied=False, duplicate_resolution_applied=False)


def metadata_fields(value, path, pointer="", chapter_context=False, source_context=None):
    """Extract scalar identity fields with one nearest, fail-closed source scope."""
    fields, relations = [], []
    if isinstance(value, list):
        children = [(str(i), child) for i, child in enumerate(value)]
    elif isinstance(value, dict):
        chapter_context = chapter_context or any(k in value for k in ("chapter_id", "sentence_id", "source_chapter_id"))
        source_keys = [k for k in ("source", "source_snapshot", "sentence_source", "original_source") if k in value]
        flat_source = "source_path" in value or "source_sha256" in value
        if source_keys or flat_source:
            refs, diagnostics = [], []
            declarations = [(pointer + "/" + k, value[k], pointer + "/" + k + "/path",
                             pointer + "/" + k + "/sha256") for k in source_keys]
            if flat_source:
                declarations.append((pointer, {"path": value.get("source_path"), "sha256": value.get("source_sha256")},
                                     pointer + "/source_path", pointer + "/source_sha256"))
            for location, ref, path_pointer, hash_pointer in declarations:
                if (not isinstance(ref, dict) or not isinstance(ref.get("path"), str) or not ref["path"].strip()
                        or not isinstance(ref.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", ref["sha256"])):
                    diagnostics.append({"code": "malformed_nearest_source_declaration", "pointer": location,
                                        "path_pointer": path_pointer, "sha256_pointer": hash_pointer})
                else:
                    refs.append({"path": ref["path"], "sha256": ref["sha256"],
                                 "path_pointer": path_pointer, "sha256_pointer": hash_pointer})
            distinct = {(r["path"], r["sha256"]) for r in refs}
            if len(distinct) > 1:
                diagnostics.append({"code": "ambiguous_nearest_source_declaration", "pointer": pointer,
                                    "distinct_reference_count": len(distinct)})
            source_context = {"declaring_object_pointer": pointer, "references": refs,
                              "diagnostics": diagnostics, "unique_valid_pin": len(distinct) == 1 and not diagnostics}
        # Reuse only V1's scalar code/title vocabulary, without its source inheritance.
        scalar = {k: item for k, item in value.items() if not isinstance(item, (dict, list))}
        fields, relations = v1.metadata_fields(scalar, path, pointer, chapter_context)
        for relation in relations:
            context = source_context or {"declaring_object_pointer": None, "references": [],
                                         "diagnostics": [], "unique_valid_pin": False}
            relation.update(source_snapshot_references=[dict(r) for r in context["references"]],
                            source_binding_diagnostics=[dict(d) for d in context["diagnostics"]],
                            nearest_source_object_pointer=context["declaring_object_pointer"],
                            nearest_source_unique_valid_pin=context["unique_valid_pin"])
        children = [(k, child) for k, child in value.items() if isinstance(child, (dict, list))]
    else:
        return fields, relations
    for key, child in children:
        escaped = key.replace("~", "~0").replace("/", "~1")
        child_chapter = chapter_context or key in ("chapters", "chapter_kv") or bool(re.fullmatch(r"[^:]+:C\d+", key))
        f, r = metadata_fields(child, path, pointer + "/" + escaped, child_chapter, source_context)
        fields.extend(f)
        relations.extend(r)
    return fields, relations


def audit_work(inputs, work, windows, metadata):
    # Chapter documents cannot supply book relations in V1. Restrict V1 to
    # structural/chapter checks so its faulty source qualification is never used.
    chapter_refs = [r for r in metadata["metadata"] if inputs.path(r["path"]).name in CHAPTER_FILES]
    result = v1.audit_work(inputs, work, windows, dict(metadata, metadata=chapter_refs))
    fields = list(result["exact_relevant_structured_fields"])
    relations, diagnostics = [], []
    issues = list(result["metadata_parse_issues"])
    conflicts, incomplete = list(result["conflicts"]), list(result["incomplete_evidence"])
    source = windows[0]["artifacts"]["sentences"]
    for ref in metadata["metadata"]:
        path = inputs.verify(ref)
        if path.name in CHAPTER_FILES:
            continue
        if path.suffix == ".jsonl":
            objects = (("/line/" + str(line), row) for line, row, _ in inputs.rows(ref, issues))
        else:
            try:
                objects = [("", inputs.load(ref))]
            except ValueError as error:
                if not str(error).startswith("malformed_json:"):
                    raise
                issues.append({"path": path.as_posix(), "code": "malformed_metadata_json_document"})
                objects = []
        for pointer, obj in objects:
            f, extracted = metadata_fields(obj, path.as_posix(), pointer)
            fields.extend(f)
            for relation in extracted:
                historical = inputs.historical_pins.get(path.as_posix(), {}).get("sha256") == ref["sha256"]
                relation.update(metadata_sha256=ref["sha256"], metadata_historically_pinned=historical,
                    metadata_snapshot_kind="historically_pinned" if historical else "current_offline_pinned_only",
                    exact_source_snapshot_match=False)
                for diagnostic in relation["source_binding_diagnostics"]:
                    diagnostic.update(path=path.as_posix(), metadata_sha256=ref["sha256"],
                                      code_pointer=relation["code_pointer"], title_pointer=relation["title_pointer"])
                    diagnostics.append(diagnostic)
                    incomplete.append(diagnostic["code"])
                if relation["nearest_source_unique_valid_pin"]:
                    # All nearest refs are the same literal path/hash. No any-match selection.
                    nearest = relation["source_snapshot_references"][0]
                    try:
                        same_path = inputs.path(nearest["path"]) == inputs.path(source["path"])
                    except ValueError:
                        same_path = False
                    matches = same_path and nearest["sha256"] == source["sha256"]
                    relation["exact_source_snapshot_match"] = matches
                    if not matches:
                        conflicts.append("metadata_source_snapshot_hash_mismatch" if same_path else
                                         "metadata_source_snapshot_path_mismatch")
                    for nearest_ref in relation["source_snapshot_references"]:
                        nearest_ref["matches_audited_snapshot"] = matches
                relation["lineage_fully_confirmed"] = historical and relation["exact_source_snapshot_match"]
                relations.append(relation)
        inputs.cache.pop(path.as_posix(), None)
    if issues:
        incomplete.append("malformed_explicit_metadata")
    status, conflicts, incomplete, interpretations = v1.classify(
        work, result["sentence_distribution"], relations, fields, conflicts, incomplete)
    lineage = bool(relations) and all(r["lineage_fully_confirmed"] for r in relations)
    result.update(version=VERSION, status=status, identifier_interpretations=interpretations,
        metadata_refs=metadata["metadata"], exact_relevant_structured_fields=fields,
        upstream_code_title_relationships=relations, metadata_parse_issues=issues,
        source_binding_diagnostics=diagnostics, source_binding_policy=POLICY,
        declared_metadata_namespace_relation="explicit_code_title_fields_present" if relations else
            "no_explicit_code_title_relationship_in_pinned_metadata",
        lineage_fully_confirmed=lineage, conflicts=conflicts, incomplete_evidence=incomplete, boundaries=BOUNDARIES)
    for binding in result["proposed_bindings"]:
        binding.update(status=status, lineage_fully_confirmed=lineage)
    return result


def verify_v1_products(inputs):
    """Verify the sealed V1 products plus all prior/preparation artifacts, read-only."""
    directory = inputs.root / V1_OUT / "completed_audit"
    manifest_ref = {"path": (directory / "manifest.json").as_posix(), "sha256": V1_MANIFEST_SHA256}
    manifest = inputs.load(manifest_ref)
    refs = [manifest_ref, manifest["script"], manifest["tests"], manifest["metadata_inventory"]]
    refs += [{"path": (directory / name).as_posix(), **pin} for name, pin in manifest["outputs"].items()]
    v1.require(manifest["script"]["sha256"] == V1_SCRIPT_SHA256, "v1_implementation_pin_disagrees")
    preservation_ref = next(r for r in manifest["inputs"] if r["path"].endswith("/prior_partial_preservation.json"))
    archive = inputs.load(preservation_ref)
    refs.append(preservation_ref)
    for original in archive["files"]:
        data = original["utf8_contents"].encode("utf-8")
        v1.require(v1.sha(data) == original["sha256"] and len(data) == original["bytes"], "prior_archive_corrupt")
        if original["path"].endswith("/metadata_pin_inventory.json"):
            refs.append({k: original[k] for k in ("path", "sha256", "bytes")})
    for ref in refs:
        inputs.verify(ref)
    report_ref = {"path": (directory / "report.json").as_posix(), **manifest["outputs"]["report.json"]}
    report = inputs.load(report_ref)
    return {"manifest": manifest_ref, "products": sorted(
        {inputs.path(r["path"]).as_posix(): inputs.observed[inputs.path(r["path"]).as_posix()] for r in refs}.values(),
        key=lambda r: r["path"]), "metadata_inventory": manifest["metadata_inventory"], "report": report}


def build(inputs, works, metadata_ref, inventory_ref):
    preserved = verify_v1_products(inputs)
    v1.require(metadata_ref == preserved["metadata_inventory"], "must_reuse_exact_sealed_v1_metadata_inventory")
    metadata = inputs.load(metadata_ref)
    records = {r["work_id"]: r for r in metadata["works"]}
    v1.require(len(records) == len(metadata["works"]) and records.keys() == works.keys(), "metadata_scope_mismatch")
    evidence = []
    for work, windows in sorted(works.items()):
        record = records[work]
        v1.require(record["source"] == windows[0]["artifacts"]["sentences"], "metadata_source_pin_mismatch")
        allowed = v1.metadata_dirs(inputs, work, record["source"])
        v1.require(record["searched_exact_directories"] == [p.as_posix() for p in allowed], "metadata_directory_mismatch")
        for ref in record["metadata"]:
            path = inputs.path(ref["path"])
            v1.require(path.parent in allowed or path.is_relative_to(allowed[0]), "foreign_work_metadata")
        evidence.append(audit_work(inputs, work, windows, record))
    counts = {s: {"works": sum(e["status"] == s for e in evidence),
                  "windows": sum(e["deferred_window_count"] for e in evidence if e["status"] == s)} for s in v1.STATUSES}
    old = preserved["report"]
    previous_status = {e["work_id"]: e["status"] for e in old["by_work"]}
    supersession = {"kind": "diagnostic_only", "sealed_v1_manifest": preserved["manifest"],
        "source_binding_policy": POLICY, "v1_products_verified_unchanged": preserved["products"],
        "same_explicit_metadata_inventory": True, "fresh_metadata_discovery": False,
        "previous_counts": old["counts"], "status_counts_unchanged": old["counts"] == counts,
        "changed_work_statuses": [{"work_id": e["work_id"], "v1": previous_status[e["work_id"]], "v2": e["status"]}
                                  for e in evidence if previous_status[e["work_id"]] != e["status"]]}
    report = {"version": VERSION, "inventory": inventory_ref, "metadata_inventory": metadata_ref,
        "exact_scope": {"works": len(evidence), "deferred_windows": sum(len(w) for w in works.values())},
        "counts": counts, "diagnostic_supersession": supersession, "boundaries": BOUNDARIES,
        "full_source_scan": {"files": len(evidence), "rows": sum(e["sentence_distribution"]["total_rows"] for e in evidence),
                             "streaming_passes": sum(e["sentence_distribution"]["full_forward_scans"] for e in evidence)},
        "observed_work_id_row_frequencies": dict(sorted(sum(
            (Counter(e["sentence_distribution"]["observed_work_id_frequencies"]) for e in evidence), Counter()).items())),
        "upstream_code_title_relationship_count": sum(len(e["upstream_code_title_relationships"]) for e in evidence),
        "source_binding_diagnostic_count": sum(len(e["source_binding_diagnostics"]) for e in evidence),
        "metadata_files": sum(len(e["metadata_refs"]) for e in evidence),
        "lineage_fully_confirmed_work_count": sum(e["lineage_fully_confirmed"] for e in evidence),
        "duplicate_flags": {"works": sum(e["sentence_distribution"]["duplicate_sentence_id_count"] > 0 for e in evidence),
            "selected_windows": sum(e["selected_duplicate_id_window_count"] for e in evidence),
            "equivalence_audited": False, "rows_collapsed": False},
        "limitations": ["Directory/work path, chapter prefixes and job.book are context, not code/title proof.",
            "Current metadata without historical pins cannot establish fully confirmed historical lineage.",
            "No absence claim outside the exact previously pinned metadata inventory.",
            "No remapping, duplicate equivalence/resolution, new source snapshot, authorization or release.",
            "All 2233 windows remain deferred; no source prose is emitted."],
        "by_work": [{k: e[k] for k in ("work_id", "status", "deferred_window_count", "conflicts", "incomplete_evidence")}
                    for e in evidence]}
    md = ["# Offline Source Namespace Binding Audit V2", "", "Diagnostic supersession only. V1 is preserved unchanged.",
          "All 2233 windows remain deferred. No remapping or authorization.", "", POLICY, "",
          "| Status | Works | Windows |", "| --- | ---: | ---: |"]
    md += [f"| {s} | {n['works']} | {n['windows']} |" for s, n in counts.items()]
    md += ["", "## Verification", "", f"Full pinned files: {len(evidence)}; sentence rows: {report['full_source_scan']['rows']}.",
           f"Pinned metadata files: {report['metadata_files']}; explicit code/title relations: {report['upstream_code_title_relationship_count']}.",
           f"V1 manifest: `{V1_MANIFEST_SHA256}`.", "V1 products, both implementations and both test files are hash-pinned in the manifest.",
           "Same explicit V1 metadata inventory; no fresh discovery.", "", "## Limitations", ""]
    md += ["- " + item for item in report["limitations"]]
    md += ["", "## Per Work", "", "| Work | Status | Windows |", "| --- | --- | ---: |"]
    md += [f"| {e['work_id']} | {e['status']} | {e['deferred_window_count']} |" for e in evidence]
    outputs = {"per_work_bindings.jsonl": b"".join(json.dumps(e, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), allow_nan=False).encode("utf-8") + b"\n" for e in evidence),
        "mapping_proposals.json": v1.encoded({"version": VERSION, "proposal_only": True,
            "binding_key": ["work_id", "source_sha256", "local_work_id"], "boundaries": BOUNDARIES,
            "bindings": [b for e in evidence for b in e["proposed_bindings"]]}),
        "metadata_inventory.json": v1.encoded(metadata), "report.json": v1.encoded(report),
        "report.md": ("\n".join(md) + "\n").encode("utf-8")}
    implementations = [v1.file_pin(Path(v1.__file__)), v1.file_pin(Path(__file__).resolve())]
    tests = [v1.file_pin(inputs.root / "tests" / name) for name in
             ("test_source_namespace_bindings.py", "test_source_namespace_bindings_v2.py")]
    for ref in implementations + tests:
        inputs.verify(ref)
    inputs.recheck()
    manifest = {"version": VERSION, "implementations": implementations, "tests": tests,
        "inventory": inventory_ref, "metadata_inventory": metadata_ref, "diagnostic_supersession": supersession,
        "boundaries": BOUNDARIES, "exact_scope": report["exact_scope"],
        "inputs": sorted(inputs.observed.values(), key=lambda r: r["path"]),
        "outputs": {name: {"sha256": v1.sha(data), "bytes": len(data)} for name, data in outputs.items()},
        "materialization": "absent_only_exclusive_create", "check": "external_manifest_sha256_and_byte_reproduction"}
    outputs["manifest.json"] = v1.encoded(manifest)
    return outputs, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--materialize", choices=("newabsent",))
    mode.add_argument("--check", choices=("newaudit",))
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--manifest-sha256", required=True)
    parser.add_argument("--metadata-inventory", type=Path, required=True)
    parser.add_argument("--metadata-sha256", required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--audit-manifest-sha256")
    args = parser.parse_args()
    inputs = v1.Inputs(ROOT)
    v1.require(args.manifest_sha256 == v1.SEALED, "wrong_external_sealed_inventory_pin")
    inventory_ref = {"path": inputs.path(args.inventory / "manifest.json").as_posix(), "sha256": args.manifest_sha256}
    metadata_ref = {"path": inputs.path(args.metadata_inventory).as_posix(), "sha256": args.metadata_sha256}
    output = inputs.path(args.out_dir)
    v1.require(output.is_relative_to(ROOT / OUT), "output_outside_owned_v2_namespace_audit")
    if args.materialize:
        v1.require(not output.exists(), "output_directory_already_exists")
        v1.require(output.parent.is_dir(), "output_parent_missing")
    if args.check:
        v1.require(args.audit_manifest_sha256, "external_output_manifest_pin_required")
        inputs.verify({"path": (output / "manifest.json").as_posix(), "sha256": args.audit_manifest_sha256})
        inputs.observed.pop((output / "manifest.json").as_posix())
    works = v1.load_scope(inputs, inventory_ref["path"], inventory_ref["sha256"])
    outputs, report = build(inputs, works, metadata_ref, inventory_ref)
    if args.materialize:
        output.mkdir()
        for name, data in outputs.items():
            with (output / name).open("xb") as handle:
                handle.write(data)
    elif args.check:
        v1.require({p.name for p in output.iterdir()} == set(outputs), "unexpected_output_file_set")
        for name, data in outputs.items():
            v1.require((output / name).read_bytes() == data, "output_not_reproducible:" + name)
    print(json.dumps({"mode": "check" if args.check else "materialize" if args.materialize else "dry_run",
        "counts": report["counts"], "manifest_sha256": v1.sha(outputs["manifest.json"]),
        "v1_products_verified_unchanged": True, "status_counts_unchanged": report["diagnostic_supersession"]["status_counts_unchanged"]}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError) as error:
        print("audit_failed: " + str(error), file=sys.stderr)
        sys.exit(1)
