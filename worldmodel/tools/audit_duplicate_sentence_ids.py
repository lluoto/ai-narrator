#!/usr/bin/env python3
"""Deterministic offline duplicate-ID audit. Default dry run; no source writes.

One forward binary LF scan counts every ID in the pinned snapshot. Only when an
ID repeats do we seek back to retain its first raw row; singleton prose is never
retained. Reports contain hashes/locators, never source text. No runner imports.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import io
import json
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = Path(__file__).resolve()
INVENTORY = "runs/_extraction_scheduler/20260924/generation_followup_inventory_v2"
INVENTORY_PIN = "b7aecb1f7009cb6353356fdff0de7ba5575965179f6bd4abb0652544f24c55da"
OUT = "runs/_extraction_scheduler/20260924/duplicate_sentence_id_audit_v1"
WORK = "\u7f51\u6e38\u4e4b\u5c04\u7834\u82cd\u7a79"
CATEGORIES = ("byte_identical_rows", "json_semantically_identical_rows", "conflicting_rows", "malformed")
BOUNDARIES = {"proposal_only": True, "resolution_applied": False, "source_mutation_authorized": False,
              "new_source_snapshot_created": False, "dispatch_authorized": False,
              "quality_certified": False, "semantic_certification": False, "no_runtime_effect": True}


def require(value, code):
    if not value:
        raise ValueError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":"),
                      allow_nan=False).encode("ascii")


def encoded(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=True, indent=2, allow_nan=False) + "\n").encode("ascii")


def jsonl(rows):
    return b"".join(canonical(row) + b"\n" for row in rows)


def strict(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate_json_key")
            result[key] = value
        return result

    def constant(_):
        raise ValueError("nonfinite_json_number")

    value = json.loads(data.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)
    canonical(value)
    return value


def payload(raw):
    # Remove exactly one physical terminator. Never split Unicode text lines.
    return raw[:-2] if raw.endswith(b"\r\n") else raw[:-1] if raw.endswith(b"\n") else raw


def locator(raw, line, offset):
    return {"line": line, "byte_offset": offset, "byte_length": len(raw),
            "row_sha256": digest(payload(raw)), "raw_lf_row_sha256": digest(raw),
            "terminator": "CRLF" if raw.endswith(b"\r\n") else "LF" if raw.endswith(b"\n") else "none"}


def stamp(path):
    s = path.stat()
    return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)


class Inputs:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.pins = {}
        self.stamps = {}
        self.cache = {}

    def path(self, text):
        text = str(text).replace("\\", "/")
        require(".." not in text.split("/"), "unsafe_path")
        p = Path(text)
        p = p.absolute() if p.is_absolute() else (self.root / p).absolute()
        require(p.is_relative_to(self.root), "path_outside_root")
        for node in (p, *p.parents):
            require(not node.is_symlink(), "symlink_or_junction")
            if node.exists():
                require(not getattr(node.lstat(), "st_file_attributes", 0) & 0x400, "symlink_or_junction")
        return p

    def observe(self, path, sha, size, before):
        require(stamp(path) == before, "input_changed_during_read")
        self.stamps[path] = before
        pin = {"path": path.as_posix(), "sha256": sha, "bytes": size}
        require(path not in self.pins or self.pins[path] == pin, "input_pin_conflict")
        self.pins[path] = pin

    def read(self, path, expected):
        require(bool(re.fullmatch(r"[0-9a-f]{64}", expected or "")), "external_input_pin_required")
        path = self.path(path)
        if path not in self.cache:
            before = stamp(path)
            data = path.read_bytes()
            self.observe(path, digest(data), len(data), before)
            self.cache[path] = data
        require(self.pins[path]["sha256"] == expected, "input_hash_mismatch")
        return self.cache[path]

    def recheck(self):
        # No second full sentence-file scan. Exact bytes were pinned during scan;
        # descriptor/path identity, size and timestamps guard concurrent changes.
        for path, before in self.stamps.items():
            require(stamp(path) == before, "input_changed_during_audit")


def records(data):
    offset = 0
    for line, raw in enumerate(io.BytesIO(data), 1):
        if payload(raw).strip():
            yield strict(payload(raw)), locator(raw, line, offset)
        offset += len(raw)


def parse_source(raw):
    try:
        row = strict(payload(raw))
        require(isinstance(row, dict), "not_object")
        sid = row.get("sentence_id")
        require(isinstance(sid, str) and bool(sid), "missing_sentence_id")
        require(isinstance(row.get("text"), str), "missing_text")
        return sid, row, None
    except (ValueError, TypeError, UnicodeError, OverflowError, RecursionError):
        # Only structurally recover an unambiguous top-level ID. Never regex a
        # broken JSON row, and never select first/last among duplicate ID keys.
        sid = None
        try:
            pairs = json.loads(payload(raw).decode("utf-8"), object_pairs_hook=lambda items: items)
            if isinstance(pairs, list):
                ids = [item[1] for item in pairs if isinstance(item, tuple) and item[0] == "sentence_id"]
                if len(ids) == 1 and isinstance(ids[0], str) and ids[0]:
                    sid = ids[0]
        except (ValueError, TypeError, UnicodeError, RecursionError):
            pass
        return sid, None, "malformed_source_row"


def scan_source(inputs, ref):
    """All IDs, one full scan; retained raw bytes belong to duplicate groups only."""
    path = inputs.path(ref["path"])
    before = stamp(path)
    first, duplicates, malformed = {}, {}, []
    h, offset, lines, valid_rows, blank = hashlib.sha256(), 0, 0, 0, 0
    with path.open("rb") as handle:
        while True:
            raw = handle.readline()
            if not raw:
                break
            lines += 1
            h.update(raw)
            loc = locator(raw, lines, offset)
            offset += len(raw)
            if not payload(raw).strip():
                blank += 1
                continue
            sid, row, error = parse_source(raw)
            if error:
                malformed.append({**loc, "reason": error, "sentence_id_sha256": digest(canonical(sid)) if sid else None})
            else:
                valid_rows += 1
            if sid is None:
                continue
            if sid not in first:
                first[sid] = loc
            else:
                if sid not in duplicates:
                    saved = handle.tell()
                    old = first[sid]
                    handle.seek(old["byte_offset"])
                    prior_raw = handle.read(old["byte_length"])
                    handle.seek(saved)
                    require(digest(prior_raw) == old["raw_lf_row_sha256"], "source_slice_changed")
                    duplicates[sid] = [(prior_raw, old)]
                duplicates[sid].append((raw, loc))
        require(stamp(path) == before, "input_changed_during_scan")
    sha = h.hexdigest()
    require(sha == ref["sha256"], "source_hash_mismatch")
    inputs.observe(path, sha, offset, before)
    counts = {"physical_lf_rows": lines, "nonblank_rows": lines - blank, "valid_sentence_rows": valid_rows,
              "blank_rows": blank, "malformed_rows": len(malformed), "distinct_sentence_ids": len(first),
              "bytes": offset, "full_forward_scans": 1}
    return first, duplicates, malformed, counts


def classify_group(work, source, sid, items):
    rows = [parse_source(raw)[1] for raw, _ in items]
    valid = all(row is not None for row in rows)
    raw_variants = Counter(digest(raw) for raw, _ in items)
    parsed_variants = Counter(digest(canonical(row)) for row in rows if row is not None)
    category = ("malformed" if not valid else "byte_identical_rows" if len({raw for raw, _ in items}) == 1
                else "json_semantically_identical_rows" if len({canonical(row) for row in rows}) == 1
                else "conflicting_rows")
    fields = {}
    for key in sorted({key for row in rows if row is not None for key in row}):
        variants = Counter(digest(canonical([key in row, row.get(key)])) for row in rows if row is not None)
        fields[key] = {"distinct_values": len(variants), "equal": valid and len(variants) == 1,
                       "value_hash_multiplicities": dict(sorted(variants.items()))}
    differing = [key for key, info in fields.items() if not info["equal"]]
    buckets = {"text": [k for k in fields if k in ("text", "exact_text", "text_sha256")],
               "chapter_work": [k for k in fields if k in ("work_id", "chapter_id", "chapter_seq")],
               "offsets_and_source_provenance": [k for k in fields if k not in
                   ("text", "exact_text", "text_sha256", "work_id", "chapter_id", "chapter_seq", "sentence_id")]}
    line_refs = [loc for _, loc in items]
    sid_hash = digest(canonical(sid))
    group = {"work_scope": work, "source_file_sha256": source["sha256"], "source_path": source["path"],
             "sentence_id_sha256": sid_hash, "category": category, "multiplicity": len(items),
             "raw_row_hash_multiplicities": dict(sorted(raw_variants.items())),
             "canonical_row_hash_multiplicities": dict(sorted(parsed_variants.items())),
             "original_line_refs": line_refs, "all_field_comparison": fields, "differing_fields": differing,
             "comparison_dimensions": {name: {"fields": keys, "equal": valid and all(fields[k]["equal"] for k in keys),
                                               "differing_fields": [k for k in keys if not fields[k]["equal"]]}
                                       for name, keys in buckets.items()},
             "cross_record_work_value_collision": "work_id" in differing,
             "proposed_remediation": "potential_deterministic_row_dedup_only_if_later_authorized"
                 if category == CATEGORIES[0] else "provenance_investigation_required",
             "proposal_only": True, "resolution_applied": False}
    if category == CATEGORIES[0]:
        group["proposed_mapping_sidecar"] = {"proposal_only": True, "resolution_applied": False,
            "source_file_sha256": source["sha256"], "sentence_id_sha256": sid_hash,
            "multiplicity": len(items), "all_original_line_refs": line_refs,
            "survivor_selected": False, "mapping_applied": False}
    group["group_sha256"] = digest(canonical(group))
    return group


def duplicate_counts(groups):
    return {"duplicate_id_groups": len(groups), "rows_in_duplicate_groups": sum(g["multiplicity"] for g in groups),
            "excess_id_occurrences": sum(g["multiplicity"] - 1 for g in groups),
            "multiplicity_histogram": dict(sorted(Counter(g["multiplicity"] for g in groups).items())),
            "category_groups": {c: sum(g["category"] == c for g in groups) for c in CATEGORIES},
            "category_rows": {c: sum(g["multiplicity"] for g in groups if g["category"] == c) for c in CATEGORIES}}


def join_window(entry, deferred_loc, coverage, generator, source, first, duplicates, groups):
    """Join by pinned rows and work scope, never by local window/ID alone."""
    cov, cloc = coverage
    gen, gloc = generator
    work = entry["work_id"]
    for row in (cov, gen):
        require(row.get("window_id") == entry["window_id"], "window_id_mismatch")
        require(row.get("work_id") in (None, work), "window_work_mismatch")
        require(row.get("chapter_id") == entry["chapter_id"], "window_chapter_mismatch")
    ids = cov["anchor_sentence_ids"] + cov["attached_sentence_ids"]
    require(isinstance(ids, list) and all(isinstance(s, str) for s in ids), "source_ids_shape")
    require(ids == gen["sentence_ids"] == entry["sentence_ids"], "window_sentence_ids_mismatch")
    require(cov.get("role") == gen.get("role"), "window_role_mismatch")
    require(digest(gen.get("raw_response", "").encode("utf-8")) == entry["raw_response_sha256"], "raw_response_pin_mismatch")
    for actual, recorded, label in ((cloc, entry["coverage_row"], "coverage"),
                                    (gloc, entry["generator_rows"][0], "generator")):
        require(recorded["file_sha256"] == entry["artifacts"][label]["sha256"], "row_file_pin_mismatch")
        require(actual["line"] == recorded["line"] and actual["row_sha256"] == recorded["row_sha256"], "window_row_pin_mismatch")
    require(len(entry["generator_rows"]) == 1, "generator_row_count_mismatch")
    expected = []
    for sid in ids:
        require(sid in first, "missing_source_id")
        locs = [loc for _, loc in duplicates[sid]] if sid in duplicates else [first[sid]]
        for loc in locs:
            expected.append((sid, loc["line"], loc["row_sha256"]))
    actual = []
    for loc in entry["sentence_rows"]:
        require(loc["file_sha256"] == source["sha256"], "sentence_row_file_pin_mismatch")
        actual.append((loc["sentence_id"], loc["line"], loc["row_sha256"]))
    require(Counter(expected) == Counter(actual), "sentence_row_binding_mismatch")
    matched = [groups[sid] for sid in sorted(set(ids)) if sid in groups]
    require(bool(matched), "ambiguous_window_has_no_duplicate")
    category = max((g["category"] for g in matched), key=CATEGORIES.index)
    return {"work_scope": work, "window_id": entry["window_id"], "chapter_id_sha256": digest(canonical(entry["chapter_id"])),
            "inventory_group_id": entry["group_id"], "deferred_record": deferred_loc,
            "coverage_record": cloc, "generator_record": gloc, "source_file_sha256": source["sha256"],
            "source_id_occurrences_in_window": len(ids), "unique_source_ids_in_window": len(set(ids)),
            "referenced_source_row_occurrences": len(expected), "duplicate_group_count": len(matched),
            "matching_source_id_groups": [{"sentence_id_sha256": g["sentence_id_sha256"],
                "group_sha256": g["group_sha256"], "category": g["category"], "multiplicity": g["multiplicity"]} for g in matched],
            "category": category, "category_rule": "most_conservative_matched_group_category",
            "original_source_blockers_preserved": entry["source_blockers"], **BOUNDARIES}


def build(root=ROOT, inventory_dir=INVENTORY, inventory_pin=INVENTORY_PIN, work=WORK, expected_windows=38):
    script_data = SCRIPT.read_bytes()
    inputs = Inputs(root)
    invdir = inputs.path(inventory_dir)
    manifest = strict(inputs.read(invdir / "manifest.json", inventory_pin))
    deferred_bytes = inputs.read(invdir / "deferred_windows.jsonl", manifest["outputs"]["deferred_windows.jsonl"]["sha256"])
    inv_report = strict(inputs.read(invdir / "report.json", manifest["outputs"]["report.json"]["sha256"]))
    entries = []
    for row, loc in records(deferred_bytes):
        if "sentence_id_ambiguous" in row.get("source_blockers", []):
            require(row["work_id"] == work, "unexpected_ambiguous_work_scope")
            require(row["decision"] == "deferred_source_or_policy", "not_deferred")
            entries.append((row, loc))
    require(len(entries) == expected_windows, "affected_window_count_mismatch")
    require(inv_report["by_reason"]["sentence_id_ambiguous"]["windows"] == expected_windows, "inventory_report_count_mismatch")
    require(len({(e["work_id"], e["group_id"], e["window_id"]) for e, _ in entries}) == expected_windows, "duplicate_window_entry")
    refs = entries[0][0]["artifacts"]
    require(all(e["artifacts"] == refs for e, _ in entries), "multiple_source_artifact_sets")
    require(set(refs) == {"coverage", "generator", "job", "sentences"}, "artifact_roles_mismatch")
    source = {**refs["sentences"], "path": inputs.path(refs["sentences"]["path"]).as_posix()}
    # Trust paths only from exact deferred records, never title-based discovery.
    require(inputs.path(source["path"]).is_relative_to(inputs.root / "runs" / work), "source_work_scope_mismatch")
    audit_dir = inputs.path(manifest["audit_dir"])
    frozen = {name: inputs.read(audit_dir / name, sha) for name, sha in manifest["audit_pins"].items()}
    audit_manifest = strict(frozen["manifest.json"])
    for name in ("report.json", "input_hashes.jsonl", "generator_repair_queue.jsonl"):
        require(name in audit_manifest["products"], "upstream_audit_product_missing")
    inventory = {}
    for row, _ in records(frozen["input_hashes.jsonl"]):
        p = inputs.path(row["path"])
        require(p not in inventory, "ambiguous_upstream_inventory_path")
        inventory[p] = row
    observed_v2 = {inputs.path(p["path"]): p for p in manifest["actual_read_inputs"]}
    for ref in refs.values():
        p = inputs.path(ref["path"])
        require(p in inventory and inventory[p]["sha256"] == ref["sha256"], "upstream_inventory_pin_mismatch")
        require(p in observed_v2 and observed_v2[p]["sha256"] == ref["sha256"], "sealed_inventory_input_pin_mismatch")
    job = strict(inputs.read(refs["job"]["path"], refs["job"]["sha256"]))
    require(job["book"] == work, "job_work_scope_mismatch")
    for label, role in (("sentences.jsonl", "sentences"), ("coverage_partition.jsonl", "coverage")):
        sha = refs[role]["sha256"]
        require(job["input_artifact_hashes"][label] == sha, "job_source_pin_mismatch")
        require(all(e["original_execution_input_pins"][label] == sha for e, _ in entries), "original_execution_pin_mismatch")
        checks = [r for r in strict(frozen["report.json"])["historical_input_hash_checks"]
                  if r["work"] == work and r["label"] == label]
        require(len(checks) == 1 and checks[0]["recorded_sha256"] == sha, "historical_pin_mismatch")
        candidates = checks[0].get("matching_paths", []) if role == "sentences" else [checks[0]["path"]]
        require(inputs.path(refs[role]["path"]) in {inputs.path(p) for p in candidates}, "historical_path_mismatch")
    wanted = {e["window_id"] for e, _ in entries}
    indexes = {}
    for role in ("coverage", "generator"):
        ref = refs[role]
        index = defaultdict(list)
        for row, loc in records(inputs.read(ref["path"], ref["sha256"])):
            if row.get("window_id") in wanted:
                index[row["window_id"]].append((row, {**loc, "path": inputs.path(ref["path"]).as_posix(), "file_sha256": ref["sha256"]}))
        require(all(len(index[wid]) == 1 for wid in wanted), "ambiguous_or_missing_window_join")
        indexes[role] = index
    first, duplicates, malformed, source_counts = scan_source(inputs, source)
    require(source_counts["bytes"] == inventory[inputs.path(source["path"])]["bytes"], "source_inventory_size_mismatch")
    groups = {sid: classify_group(work, source, sid, items) for sid, items in sorted(duplicates.items())}
    windows = []
    for entry, loc in entries:
        wid = entry["window_id"]
        for role in ("coverage", "generator"):
            recorded = entry["coverage_row"] if role == "coverage" else entry["generator_rows"][0]
            require(inputs.path(recorded["path"]) == inputs.path(refs[role]["path"]), "row_path_mismatch")
        for sloc in entry["sentence_rows"]:
            require(inputs.path(sloc["path"]) == inputs.path(source["path"]), "source_row_path_mismatch")
        require(entry["audited_sentence_aliases"] == [refs["sentences"]], "unexpected_sentence_aliases")
        require(indexes["coverage"][wid][0][0].get("role") in job["roles"], "job_window_role_mismatch")
        windows.append(join_window(entry, {**loc, "path": (invdir / "deferred_windows.jsonl").as_posix(),
            "file_sha256": manifest["outputs"]["deferred_windows.jsonl"]["sha256"]},
            indexes["coverage"][wid][0], indexes["generator"][wid][0], source, first, duplicates, groups))
    windows.sort(key=lambda w: (w["work_scope"], w["window_id"], w["inventory_group_id"]))
    used = {g["group_sha256"] for w in windows for g in w["matching_source_id_groups"]}
    all_groups = list(groups.values())
    affected = [g for g in all_groups if g["group_sha256"] in used]
    unaffected = [g for g in all_groups if g["group_sha256"] not in used]
    report = {"schema_version": 1, "offline_only": True, "model_calls": 0, "network_calls": 0,
        "work_scope": work, "source_snapshot": source, "full_source": source_counts,
        "whole_file_duplicates": duplicate_counts(all_groups), "affected_window_duplicates": duplicate_counts(affected),
        "duplicates_not_referenced_by_affected_windows": duplicate_counts(unaffected),
        "affected_windows": len(windows), "window_category_partition": {c: sum(w["category"] == c for w in windows) for c in CATEGORIES},
        "window_category_presence_overlapping": {c: sum(any(g["category"] == c for g in w["matching_source_id_groups"]) for w in windows) for c in CATEGORIES},
        "malformed_row_locators": malformed, "checks": {"upstream_audit_pins_verified": True,
            "upstream_inventory_artifact_pins_verified": True, "original_job_source_pins_verified": True,
            "exact_window_and_source_row_binding": True, "all_duplicate_ids_counted": True},
        "policy": ["JSON semantic identity means exact canonical parsed JSON equality only; no language model or quality claim.",
            "Byte identity includes the physical LF/CRLF terminator or its absence; row_sha256 excludes exactly one terminator.",
            "All fields, including original character offsets and source provenance, participate in full-record equality.",
            "Only byte-identical groups are potential deterministic row-dedup proposals; no deletion or survivor is authorized.",
            "Every other group requires provenance investigation, never first/last precedence or guessed resolution.",
            "Original work scopes and blockers remain unchanged; B001 namespace/metadata mapping is outside this audit.",
            "Malformed rows without an unambiguous parsed ID are reported separately and never assigned a guessed group.",
            "Raw bytes are retained in memory for duplicate groups only, never emitted as source prose or a new snapshot."],
        **BOUNDARIES}
    products = {"groups.jsonl": jsonl(all_groups), "affected_windows.jsonl": jsonl(windows), "report.json": encoded(report)}
    md = ["# Offline Duplicate Sentence-ID Audit", "", "Proposal only. No source mutation, resolution, namespace mapping or quality certification.",
          "", "## Counts", "", "```json", encoded({k: report[k] for k in ("full_source", "whole_file_duplicates",
          "affected_window_duplicates", "duplicates_not_referenced_by_affected_windows", "window_category_partition")}).decode().rstrip(),
          "```", "", "## Policy", "", *["- " + p for p in report["policy"]], "",
          "Exact row/group bindings are in affected_windows.jsonl and groups.jsonl. All original multiplicities are preserved.", ""]
    products["report.md"] = "\n".join(md).encode("ascii")
    require(SCRIPT.read_bytes() == script_data, "script_changed_during_audit")
    inputs.recheck()
    output_manifest = {"schema_version": 1, "root": inputs.root.as_posix(), "inventory_dir": invdir.as_posix(),
        "external_inventory_manifest_sha256": inventory_pin, "work_scope": work, "expected_windows": expected_windows,
        "script": {"path": SCRIPT.as_posix(), "sha256": digest(script_data), "bytes": len(script_data)},
        "inputs": sorted(inputs.pins.values(), key=lambda p: p["path"]),
        "outputs": {name: {"sha256": digest(data), "bytes": len(data)} for name, data in sorted(products.items())},
        "source_read_strategy": "one_forward_binary_LF_scan_plus_hash_checked_duplicate_first_row_slices",
        "concurrency_guard": "path_identity_size_mtime_ctime_before_after; full_source_hash_verified_in_scan",
        "manifest_integrity": "external_SHA256_no_circular_self_pin", "absent_only": True, **BOUNDARIES}
    products["manifest.json"] = encoded(output_manifest)
    return products, report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--inventory-dir", default=INVENTORY)
    parser.add_argument("--inventory-manifest-sha256", default=INVENTORY_PIN)
    parser.add_argument("--out-dir", type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--materialize", action="store_true")
    mode.add_argument("--check", type=Path)
    parser.add_argument("--manifest-sha256")
    args = parser.parse_args(argv)
    try:
        if args.check:
            require(bool(re.fullmatch(r"[0-9a-f]{64}", args.manifest_sha256 or "")), "external_output_manifest_pin_required")
            data = (args.check / "manifest.json").read_bytes()
            require(digest(data) == args.manifest_sha256, "output_manifest_hash_mismatch")
            old = strict(data)
            require(old["script"]["sha256"] == digest(SCRIPT.read_bytes()), "script_pin_mismatch")
            root, invdir, pin = old["root"], old["inventory_dir"], old["external_inventory_manifest_sha256"]
            require(pin == args.inventory_manifest_sha256, "external_inventory_pin_conflict")
            checked = Inputs(root).path(args.check)
            require(checked == Inputs(root).path(OUT), "check_not_owned_audit_directory")
        else:
            root, invdir, pin = args.root, args.inventory_dir, args.inventory_manifest_sha256
        out = Inputs(root).path(args.out_dir or OUT)
        if args.materialize:
            require(not out.exists() and out.parent.is_dir(), "new_absent_output_directory_required")
            require(out == Inputs(root).path(OUT), "output_not_owned_audit_directory")
            require(not out.is_relative_to(Inputs(root).path(invdir)), "output_inside_sealed_inventory")
        products, report = build(root, invdir, pin)
        if args.check:
            require({p.name for p in args.check.iterdir()} == set(products), "output_file_set_mismatch")
            for name, data in products.items():
                require((args.check / name).read_bytes() == data, "output_replay_mismatch:" + name)
        elif args.materialize:
            out.mkdir(exist_ok=False)
            for name, data in sorted(products.items()):
                with (out / name).open("xb") as handle:
                    handle.write(data)
        print(json.dumps({"mode": "check" if args.check else "materialize" if args.materialize else "dry_run",
            "full_source": report["full_source"], "whole_file_duplicates": report["whole_file_duplicates"],
            "affected_window_duplicates": report["affected_window_duplicates"],
            "window_category_partition": report["window_category_partition"],
            "manifest_sha256": digest(products["manifest.json"]),
            "output_hashes": {name: digest(data) for name, data in sorted(products.items())}}, sort_keys=True))
        return 0
    except (ValueError, OSError, KeyError, TypeError, IndexError) as error:
        # Error codes only: parsing exceptions may otherwise quote source prose.
        code = str(error)
        print("FAIL: " + (code if re.fullmatch(r"[a-z_]+(?::[a-z_.]+)?", code) else "invalid_or_unavailable_input"), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
