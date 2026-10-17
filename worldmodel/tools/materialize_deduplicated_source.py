#!/usr/bin/env python3
"""Offline, absent-only approved derived snapshot; default is a write-free dry run.

--out-dir names the new bundle container (its parent must already exist). All
artifacts live in its work-specific child. A final externally pinned manifest,
not attempt.json or partially written streams, is the acceptance marker.
"""
from __future__ import annotations

import argparse
from collections import Counter
from contextlib import ExitStack
import hashlib
import json
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = Path(__file__).resolve()
SCHEDULER = "runs/_extraction_scheduler/20260924"
AUDIT = SCHEDULER + "/duplicate_sentence_id_audit_v1"
AUDIT_PIN = "4bd17418e441a620395e2f1c56812c16cb9dfa406b7d7a59cdb0aacc7abe3e33"
OUT = SCHEDULER + "/source_deduplication_approved_v1"
WORK = "\u7f51\u6e38\u4e4b\u5c04\u7834\u82cd\u7a79"
SOURCE_PIN = "d33080a35bd8a0a07b6a497079b475f289af6cecafbb269d1b71e6930ae6fdbd"
AUTHORIZATION = {
    "user_text": "1\uff0c2\u6279\u51c6", "authorized_by": "user",
    "executor": "assistant", "human_semantic_review_claimed": False,
    "scope": "new_derived_snapshot_only_from_exact_pinned_audit_and_source",
    "survivor_policy": "retain_earliest_physical_occurrence_per_sentence_id",
    "duplicate_policy": "entire_raw_record_including_terminator_must_equal_first",
}
BOUNDARIES = {
    "source_namespace_mapping_approved": False, "malformed_metadata_resolved": False,
    "deferred_windows_released": 0, "dispatch_authorized": False,
    "qwen_dispatch_authorized": False, "runtime_effect": False,
    "quality_certified": False, "semantic_certification": False,
    "promotion_authorized": False, "original_source_mutation_authorized": False,
    "original_generator_binding_repaired": False, "separate_source_identity_approval_required": True,
    "new_scope_required": True, "network_calls": 0, "model_calls": 0,
}


def require(condition, code):
    if not condition:
        raise ValueError(code)


def digest(data):
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
        raise ValueError("nonfinite_json_number")

    value = json.loads(data.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)
    encoded(value)
    return value


def payload(raw):
    return raw[:-2] if raw.endswith(b"\r\n") else raw[:-1] if raw.endswith(b"\n") else raw


def locator(raw, line, offset):
    terminator = b"\r\n" if raw.endswith(b"\r\n") else b"\n" if raw.endswith(b"\n") else b""
    return {"line": line, "byte_offset": offset, "byte_length": len(raw),
            "row_sha256": digest(payload(raw)), "raw_lf_row_sha256": digest(raw),
            "terminator": "CRLF" if terminator == b"\r\n" else "LF" if terminator else "none"}


def source_row(raw):
    row = strict(payload(raw))
    require(isinstance(row, dict), "malformed_source_row")
    require(isinstance(row.get("sentence_id"), str) and bool(row["sentence_id"]), "missing_sentence_id")
    require(isinstance(row.get("text"), str), "missing_text")
    return row


def stamp(path):
    stat = path.stat()
    return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)


def safe_path(root, text):
    text = str(text).replace("\\", "/")
    require(".." not in text.split("/"), "unsafe_path")
    path = Path(text)
    path = path.absolute() if path.is_absolute() else (root / path).absolute()
    require(path.is_relative_to(root), "path_outside_root")
    for node in (path, *path.parents):
        require(not node.is_symlink(), "symlink_or_junction")
        if node.exists():
            require(not getattr(node.lstat(), "st_file_attributes", 0) & 0x400, "symlink_or_junction")
    return path


def file_pin(path):
    before = stamp(path)
    h, size = hashlib.sha256(), 0
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
            size += len(chunk)
    require(stamp(path) == before, "file_changed_during_hash")
    return {"sha256": h.hexdigest(), "bytes": size}


class Context:
    def __init__(self, root=ROOT, audit_dir=AUDIT, audit_pin=AUDIT_PIN, allow_missing_source=False):
        self.root = Path(root).absolute()
        self.audit_dir = safe_path(self.root, audit_dir)
        self.audit_pin = audit_pin
        self.pins, self.stamps = {}, {}
        manifest_path = self.audit_dir / "manifest.json"
        self.observe(manifest_path, {"sha256": audit_pin})
        self.audit = strict(manifest_path.read_bytes())
        require(self.audit["root"] == self.root.as_posix(), "audit_root_mismatch")
        self.work = self.audit["work_scope"]
        require(self.work == WORK, "work_scope_mismatch")
        report_path = self.audit_dir / "report.json"
        self.observe(report_path, self.audit["outputs"]["report.json"])
        self.report = strict(report_path.read_bytes())
        self.groups_path = self.audit_dir / "groups.jsonl"
        self.observe(self.groups_path, self.audit["outputs"]["groups.jsonl"])
        require(self.report["work_scope"] == self.work, "report_scope_mismatch")
        ref = self.report["source_snapshot"]
        self.source_path = safe_path(self.root, ref["path"])
        matches = [r for r in self.audit["inputs"] if safe_path(self.root, r["path"]) == self.source_path]
        require(len(matches) == 1, "ambiguous_source_metadata")
        self.source = {**matches[0], "path": self.source_path.as_posix()}
        require(self.source["sha256"] == ref["sha256"], "source_metadata_pin_mismatch")
        require(self.source["bytes"] == self.report["full_source"]["bytes"], "source_metadata_size_mismatch")
        self.source_available = self.source_path.is_file()
        if self.source_available or not allow_missing_source:
            self.observe(self.source_path, self.source)
        else:
            self.pins[self.source_path] = self.source
        self.script_pin = {"path": SCRIPT.as_posix(), **file_pin(SCRIPT)}
        # The script is pinned separately: fixture roots need not contain it.
        self.script_stamp = stamp(SCRIPT)
        self.before = self.input_pins()

    def observe(self, path, expected):
        path = safe_path(self.root, path)
        before = stamp(path)
        actual = file_pin(path)
        require(actual["sha256"] == expected["sha256"], "input_hash_mismatch")
        require("bytes" not in expected or actual["bytes"] == expected["bytes"], "input_size_mismatch")
        require(stamp(path) == before, "input_changed_during_read")
        self.pins[path] = {"path": path.as_posix(), **actual}
        self.stamps[path] = before

    def input_pins(self):
        return sorted(self.pins.values(), key=lambda ref: ref["path"])

    def recheck(self):
        for path, before in self.stamps.items():
            require(stamp(path) == before, "input_changed_during_execution")
            require(file_pin(path) == {k: self.pins[path][k] for k in ("sha256", "bytes")},
                    "input_hash_changed_after")
        require(stamp(SCRIPT) == self.script_stamp and file_pin(SCRIPT) ==
                {k: self.script_pin[k] for k in ("sha256", "bytes")}, "code_changed_during_execution")
        return self.input_pins()


class Stream:
    def __init__(self, handle=None):
        self.handle, self.h, self.size = handle, hashlib.sha256(), 0

    def write(self, raw):
        if self.handle is not None:
            self.handle.write(raw)
        self.h.update(raw)
        self.size += len(raw)

    def pin(self):
        return {"sha256": self.h.hexdigest(), "bytes": self.size}


def lineage_record(ctx, row, raw, original, derived, first_line):
    retained = original["line"] == first_line
    return {
        "sentence_id": row["sentence_id"],
        "source_id": row.get("source_id", row["sentence_id"]),
        "source_id_basis": "record_source_id" if "source_id" in row else "record_sentence_id",
        "source_path": ctx.source["path"], "source_file_sha256": ctx.source["sha256"],
        "work_scope": ctx.work,
        "source_work_fields": {key: row[key] for key in
                               ("work_id", "source_work", "source_work_id", "sourcework") if key in row},
        "original": original, "derived": derived,
        "terminator_hex": "0d0a" if raw.endswith(b"\r\n") else "0a" if raw.endswith(b"\n") else "",
        "end_bytes_hex": raw[-8:].hex(),
        "disposition": "retained_first_occurrence" if retained else "duplicate_of_first_occurrence",
        "retained_original_line": first_line,
        "duplicate_of_original_line": None if retained else first_line,
        "duplicate_of_derived_line": None if retained else derived["line"],
    }


def validate_groups(ctx, duplicates):
    expected = iter(sorted(duplicates))
    h, count = hashlib.sha256(), 0
    histogram = Counter()
    with ctx.groups_path.open("rb") as handle:
        for raw in handle:
            h.update(raw)
            group = strict(payload(raw))
            group_hash = group.pop("group_sha256")
            require(digest(encoded(group)[:-1]) == group_hash, "audit_group_hash_mismatch")
            sid = next(expected, None)
            require(sid is not None, "unexpected_audit_group")
            locs = duplicates[sid]
            require(group["sentence_id_sha256"] == digest(encoded(sid)[:-1]), "audit_group_order_or_id_mismatch")
            require(group["work_scope"] == ctx.work and group["source_file_sha256"] == ctx.source["sha256"]
                    and safe_path(ctx.root, group["source_path"]) == ctx.source_path, "audit_group_source_mismatch")
            require(group["category"] == "byte_identical_rows", "audit_group_not_byte_identical")
            require(group["original_line_refs"] == locs, "audit_duplicate_locator_mismatch")
            require(group["multiplicity"] == len(locs), "audit_multiplicity_mismatch")
            require(group["raw_row_hash_multiplicities"] == {locs[0]["raw_lf_row_sha256"]: len(locs)},
                    "audit_duplicate_hash_mismatch")
            histogram[str(len(locs))] += 1
            count += 1
    require(next(expected, None) is None, "missing_audit_group")
    require(h.hexdigest() == ctx.pins[ctx.groups_path]["sha256"], "audit_groups_stream_hash_mismatch")
    approved = ctx.report["whole_file_duplicates"]
    require(count == approved["duplicate_id_groups"] and dict(histogram) == approved["multiplicity_histogram"],
            "audit_group_counts_mismatch")
    require(approved["category_groups"]["byte_identical_rows"] == count, "audit_category_counts_mismatch")
    return count, dict(sorted(histogram.items()))


def summary(ctx, rows, unique, source_bytes, derived_pin, duplicates):
    groups, histogram = validate_groups(ctx, duplicates)
    full = ctx.report["full_source"]
    require(rows == full["physical_lf_rows"] == full["nonblank_rows"] == full["valid_sentence_rows"],
            "source_row_count_mismatch")
    require(full["blank_rows"] == full["malformed_rows"] == 0, "audit_malformed_rows")
    require(unique == full["distinct_sentence_ids"], "distinct_id_count_mismatch")
    require(rows - unique == ctx.report["whole_file_duplicates"]["excess_id_occurrences"], "removed_count_mismatch")
    require(sum(len(locs) for locs in duplicates.values()) ==
            ctx.report["whole_file_duplicates"]["rows_in_duplicate_groups"], "duplicate_row_count_mismatch")
    return {"original_rows": rows, "derived_rows": unique, "removed_occurrences": rows - unique,
            "duplicate_groups": groups, "multiplicity_histogram": histogram,
            "original_bytes": source_bytes, "derived_bytes": derived_pin["bytes"],
            "removed_bytes": source_bytes - derived_pin["bytes"],
            "original_sha256": ctx.source["sha256"], "derived_sha256": derived_pin["sha256"]}


def scan(ctx, bundle=None):
    first, duplicates = {}, {}
    source_hash, offset, lines = hashlib.sha256(), 0, 0
    with ExitStack() as stack:
        source = stack.enter_context(ctx.source_path.open("rb"))
        slices = stack.enter_context(ctx.source_path.open("rb"))
        streams = {name: Stream(stack.enter_context((bundle / name).open("xb")) if bundle else None)
                   for name in ("sentences_deduplicated.jsonl", "occurrence_lineage.jsonl")}
        derived, lineage = streams.values()
        for lines, raw in enumerate(source, 1):
            source_hash.update(raw)
            row = source_row(raw)
            sid = row["sentence_id"]
            original = locator(raw, lines, offset)
            offset += len(raw)
            if sid not in first:
                target = locator(raw, len(first) + 1, derived.size)
                first[sid] = (original, target)
                derived.write(raw)
            else:
                prior, target = first[sid]
                slices.seek(prior["byte_offset"])
                prior_raw = slices.read(prior["byte_length"])
                require(digest(prior_raw) == prior["raw_lf_row_sha256"], "source_slice_hash_mismatch")
                require(prior_raw == raw, "same_id_nonidentical_raw_record")
                if sid not in duplicates:
                    duplicates[sid] = [prior]
                duplicates[sid].append(original)
            lineage.write(encoded(lineage_record(ctx, row, raw, original, target, first[sid][0]["line"])))
        require(source_hash.hexdigest() == ctx.source["sha256"], "source_stream_hash_mismatch")
        require(offset == ctx.source["bytes"], "source_stream_size_mismatch")
        pins = {name: stream.pin() for name, stream in streams.items()}
    counts = summary(ctx, lines, len(first), offset, pins["sentences_deduplicated.jsonl"], duplicates)
    return counts, pins


def verify_streams(ctx, bundle, pins):
    """Replay every occurrence, comparing original bytes when present, without a copy."""
    for name, pin in pins.items():
        path = safe_path(ctx.root, bundle / name)
        require(file_pin(path) == pin, "output_hash_mismatch")
    first, duplicates = {}, {}
    original_hash, original_offset, next_offset, lines = hashlib.sha256(), 0, 0, 0
    with ExitStack() as stack:
        derived = stack.enter_context((bundle / "sentences_deduplicated.jsonl").open("rb"))
        lineage = stack.enter_context((bundle / "occurrence_lineage.jsonl").open("rb"))
        original = stack.enter_context(ctx.source_path.open("rb")) if ctx.source_available else None
        for lines, entry_raw in enumerate(lineage, 1):
            entry = strict(payload(entry_raw))
            target = entry["derived"]
            require(type(target["byte_offset"]) is int and 0 <= target["byte_offset"] <
                    pins["sentences_deduplicated.jsonl"]["bytes"], "invalid_derived_offset")
            derived.seek(target["byte_offset"])
            raw = derived.readline()
            row = source_row(raw)
            sid = row["sentence_id"]
            loc = locator(raw, lines, original_offset)
            if sid not in first:
                expected_target = locator(raw, len(first) + 1, next_offset)
                require(target == expected_target, "derived_order_or_locator_mismatch")
                first[sid] = (loc, expected_target)
                next_offset += len(raw)
            else:
                prior, expected_target = first[sid]
                require(target == expected_target and loc["raw_lf_row_sha256"] == prior["raw_lf_row_sha256"],
                        "duplicate_target_mismatch")
                if sid not in duplicates:
                    duplicates[sid] = [prior]
                duplicates[sid].append(loc)
            expected = lineage_record(ctx, row, raw, loc, first[sid][1], first[sid][0]["line"])
            require(entry_raw == encoded(expected), "lineage_replay_mismatch")
            if original is not None:
                require(original.readline() == raw, "original_raw_row_equality_mismatch")
            original_hash.update(raw)
            original_offset += len(raw)
        require(original is None or not original.read(1), "original_rows_missing_from_lineage")
        require(next_offset == pins["sentences_deduplicated.jsonl"]["bytes"], "unreferenced_derived_bytes")
    require(original_hash.hexdigest() == ctx.source["sha256"] and original_offset == ctx.source["bytes"],
            "original_reconstruction_hash_mismatch")
    for name, pin in pins.items():
        require(file_pin(bundle / name) == pin, "output_changed_during_check")
    return summary(ctx, lines, len(first), original_offset, pins["sentences_deduplicated.jsonl"], duplicates)


def attempt(ctx):
    return {"status": "incomplete_unless_final_manifest_is_present_and_externally_verified",
            "accepted": False, "authorization": AUTHORIZATION, "audit_manifest_sha256": ctx.audit_pin,
            "source": ctx.source, "work_scope": ctx.work, **BOUNDARIES}


def manifest(ctx, counts, outputs, after):
    return {"schema_version": 1, "status": "complete", "accepted_derived_snapshot": True,
            "root": ctx.root.as_posix(), "work_scope": ctx.work, "absent_only": True,
            "audit_dir": ctx.audit_dir.as_posix(), "external_audit_manifest_sha256": ctx.audit_pin,
            "authorization": {**AUTHORIZATION, "audit_manifest_sha256": ctx.audit_pin, "source": ctx.source},
            "source_before": ctx.source, "source_after": ctx.source,
            "inputs_before": ctx.before, "inputs_after": after, "script": ctx.script_pin,
            "counts": counts, "outputs": dict(sorted(outputs.items())),
            "output_hashes_before_replay": dict(sorted(outputs.items())),
            "output_hashes_after_replay": dict(sorted(outputs.items())),
            "verification": {"source_stream_hash_matched": True, "raw_row_equality": True,
                             "complete_occurrence_lineage": True, "original_reconstruction_hash_matched": True,
                             "audit_groups_exactly_matched": True, "output_hashes_checked_after_replay": True},
            "character_offset_policy": "unchanged_original_fields_in_exact_raw_survivor_bytes",
            "ordering": "original_physical_LF_order; first_occurrence_survivors; one_lineage_row_per_original_row",
            "manifest_integrity": "external_SHA256_no_circular_self_pin", **BOUNDARIES}


def run(root=ROOT, audit_dir=AUDIT, audit_pin=AUDIT_PIN, out_dir=OUT, materialize=False):
    ctx = Context(root, audit_dir, audit_pin)
    out = safe_path(ctx.root, out_dir)
    require(out == safe_path(ctx.root, OUT), "output_not_owned_directory")
    bundle = out / ctx.work
    attempt_bytes = encoded(attempt(ctx))
    if materialize:
        require(not out.exists() and out.parent.is_dir(), "new_absent_output_directory_parent_required")
        out.mkdir(exist_ok=False)
        bundle.mkdir(exist_ok=False)
        with (bundle / "attempt.json").open("xb") as handle:
            handle.write(attempt_bytes)
    # Dry runs write nothing. Explicit attempts retain an audit marker on failure,
    # but no source/lineage streams are opened until this preflight succeeds.
    counts, pins = scan(ctx)
    after = ctx.recheck()
    outputs = {**pins, "attempt.json": {"sha256": digest(attempt_bytes), "bytes": len(attempt_bytes)}}
    expected = encoded(manifest(ctx, counts, outputs, after))
    if materialize:
        actual_counts, actual_pins = scan(ctx, bundle)
        require(actual_counts == counts and actual_pins == pins, "materialization_preflight_mismatch")
        require(verify_streams(ctx, bundle, outputs) == counts, "materialization_replay_mismatch")
        require(ctx.recheck() == after, "input_pins_changed_after")
        # Final manifest is last. Any exception above leaves only unaccepted audit artifacts.
        with (bundle / "manifest.json").open("xb") as handle:
            handle.write(expected)
        require(file_pin(bundle / "manifest.json")["sha256"] == digest(expected), "manifest_write_mismatch")
    return {"mode": "materialize" if materialize else "dry_run", "counts": counts,
            "bundle": bundle.as_posix(), "manifest_sha256": digest(expected), "outputs": outputs, **BOUNDARIES}


def check(root, bundle, manifest_pin, audit_pin=AUDIT_PIN):
    require(bool(re.fullmatch(r"[0-9a-f]{64}", manifest_pin or "")), "external_manifest_pin_required")
    root = Path(root).absolute()
    bundle = safe_path(root, bundle)
    require(bundle == safe_path(root, OUT) / WORK, "check_not_owned_directory")
    manifest_path = safe_path(root, bundle / "manifest.json")
    data = manifest_path.read_bytes()
    require(digest(data) == manifest_pin, "output_manifest_hash_mismatch")
    old = strict(data)
    require(old["external_audit_manifest_sha256"] == audit_pin, "external_audit_pin_conflict")
    ctx = Context(root, old["audit_dir"], audit_pin, allow_missing_source=True)
    require(old["script"] == ctx.script_pin, "script_pin_mismatch")
    names = {"sentences_deduplicated.jsonl", "occurrence_lineage.jsonl", "attempt.json"}
    require(set(old["outputs"]) == names, "unsafe_output_names")
    require({p.name for p in bundle.iterdir()} == names | {"manifest.json"}, "output_file_set_mismatch")
    require((safe_path(root, bundle / "attempt.json")).read_bytes() == encoded(attempt(ctx)), "attempt_pin_mismatch")
    counts = verify_streams(ctx, bundle, old["outputs"])
    after = ctx.recheck()
    require(data == encoded(manifest(ctx, counts, old["outputs"], after)), "manifest_replay_mismatch")
    require(manifest_path.read_bytes() == data, "manifest_changed_during_check")
    return {"mode": "check", "counts": counts, "manifest_sha256": manifest_pin,
            "original_available": ctx.source_available,
            "verification": "raw_original_equality_and_reconstruction" if ctx.source_available else
                            "complete_lineage_reconstruction_to_pinned_original_hash", **BOUNDARIES}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--audit-dir", default=AUDIT)
    parser.add_argument("--out-dir", default=OUT)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--materialize", action="store_true")
    mode.add_argument("--check", type=Path)
    parser.add_argument("--manifest-sha256")
    args = parser.parse_args(argv)
    try:
        if args.check:
            result = check(args.root, args.check, args.manifest_sha256)
        else:
            ctx = Context(args.root, args.audit_dir)
            require(ctx.source["sha256"] == SOURCE_PIN and ctx.source["bytes"] == 69550897,
                    "approved_source_pin_mismatch")
            require(ctx.report["full_source"]["physical_lf_rows"] == 99683 and
                    ctx.report["full_source"]["distinct_sentence_ids"] == 71258 and
                    ctx.report["whole_file_duplicates"]["duplicate_id_groups"] == 28425,
                    "approved_source_counts_mismatch")
            result = run(args.root, args.audit_dir, AUDIT_PIN, args.out_dir, args.materialize)
        print(json.dumps(result, ensure_ascii=True, sort_keys=True))
        return 0
    except (ValueError, OSError, KeyError, TypeError, IndexError, OverflowError, RecursionError) as error:
        code = str(error)
        print("FAIL: " + (code if re.fullmatch(r"[a-z_]+", code) else "invalid_or_unavailable_input"), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
