#!/usr/bin/env python3
"""Deterministic offline namespace evidence, never source repair or dispatch.

--prepare-metadata is a separate, bounded filename discovery step. Audit/check
read only explicitly pinned metadata (or no metadata); no corpus discovery,
runner import, row normalization, or duplicate equivalence analysis.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import re
import sys

VERSION = "source_namespace_binding_audit_v1.1"
ROOT = Path(__file__).resolve().parents[1]
BASE = Path("runs/_extraction_scheduler/20260924")
SEALED = "b7aecb1f7009cb6353356fdff0de7ba5575965179f6bd4abb0652544f24c55da"
OUT = BASE / "source_namespace_binding_audit_v1"
BOUNDARIES = dict(source_modified=False, dispatch_authorized=False,
                  deferred_not_released=True, proposal_only=True,
                  quality_certified=False, promotion_authorized=False,
                  runtime_effect=False, schema_gate_changed=False,
                  cross_book_merge=False, model_calls=0, network_calls=0,
                  no_runtime_effect=True, dispatch=False, new_source_snapshot_created=False)
STATUSES = ("supported_local_namespace_mapping", "mapping_candidate_needs_approval",
            "unresolved", "conflicting_identity")


def require(value, code):
    if not value:
        raise ValueError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2,
                       allow_nan=False) + "\n").encode("utf-8")


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


def file_pin(path):
    h, size = hashlib.sha256(), 0
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
            size += len(chunk)
    return {"path": path.as_posix(), "sha256": h.hexdigest(), "bytes": size}


class Inputs:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.observed = {}
        self.cache = {}
        self.stream_guards = {}
        self.historical_pins = {}

    def path(self, text):
        text = str(text).replace("\\", "/")
        mounted = re.fullmatch(r"/mnt/([a-zA-Z])/(.+)", text)
        if mounted:
            text = mounted[1].upper() + ":/" + mounted[2]
        require(".." not in text.split("/"), "unsafe_path")
        path = Path(text)
        if not path.is_absolute():
            path = self.root / path
        path = path.absolute()
        require(path.is_relative_to(self.root), "path_outside_root")
        for node in (path, *path.parents):
            require(not node.is_symlink(), "symlink_or_junction")
            if node.exists():
                require(not (getattr(node.lstat(), "st_file_attributes", 0) & 0x400),
                        "symlink_or_junction")
        return path

    def verify(self, ref):
        path = self.path(ref["path"])
        key = path.as_posix()
        if key not in self.observed:
            self.observed[key] = file_pin(path)
        pin = self.observed[key]
        require(pin["sha256"] == ref["sha256"], "input_hash_mismatch:" + key)
        require("bytes" not in ref or ref["bytes"] == pin["bytes"], "input_size_mismatch")
        return path

    def load(self, ref):
        path = self.verify(ref)
        key = path.as_posix()
        if key not in self.cache:
            data = path.read_bytes()
            require(sha(data) == ref["sha256"], "input_changed_before_parse")
            try:
                self.cache[key] = strict(data)
            except ValueError as error:
                raise ValueError("malformed_json:" + key) from error
        return self.cache[key]

    def rows(self, ref, metadata_issues=None, stream_only=False):
        path = self.path(ref["path"]) if stream_only else self.verify(ref)
        before = path.stat()
        h = hashlib.sha256()
        size = 0
        with path.open("rb") as handle:
            for line, raw in enumerate(handle, 1):
                h.update(raw)
                size += len(raw)
                if raw.strip():
                    try:
                        row = strict(raw)
                    except ValueError as error:
                        if metadata_issues is not None:
                            metadata_issues.append({"path": path.as_posix(), "line": line,
                                                    "row_sha256": sha(raw.rstrip(b"\r\n")),
                                                    "code": "malformed_metadata_jsonl_record"})
                            continue
                        raise ValueError("malformed_jsonl:" + path.as_posix() + ":" + str(line)) from error
                    if not isinstance(row, dict) and metadata_issues is not None:
                        metadata_issues.append({"path": path.as_posix(), "line": line,
                                                "row_sha256": sha(raw.rstrip(b"\r\n")),
                                                "code": "metadata_jsonl_row_not_object"})
                        continue
                    require(isinstance(row, dict), "jsonl_row_not_object")
                    yield line, row, sha(raw.rstrip(b"\r\n"))
        require(h.hexdigest() == ref["sha256"], "input_hash_mismatch_during_parse")
        if stream_only:
            after = path.stat()
            require(before == after, "input_changed_during_parse")
            require("bytes" not in ref or ref["bytes"] == size, "input_size_mismatch")
            self.observed[path.as_posix()] = {"path": path.as_posix(), "sha256": h.hexdigest(), "bytes": size}
            self.stream_guards[path.as_posix()] = after

    def recheck(self):
        for pin in self.observed.values():
            if pin["path"] in self.stream_guards:
                require(self.path(pin["path"]).stat() == self.stream_guards[pin["path"]],
                        "input_changed_after_parse:" + pin["path"])
            else:
                require(file_pin(self.path(pin["path"])) == pin, "input_changed_after_parse:" + pin["path"])


def load_scope(inputs, inventory_path, inventory_sha=SEALED):
    manifest = inputs.load({"path": str(inventory_path), "sha256": inventory_sha})
    directory = inputs.path(inventory_path).parent
    def output(name):
        return {"path": str(directory / name), **manifest["outputs"][name]}
    for name in manifest["outputs"]:
        inputs.verify(output(name))
    report = inputs.load(output("report.json"))
    inputs.verify(output("report.md"))
    queue = [row for _, row, _ in inputs.rows(output("deferred_windows.jsonl"))]
    require(len(queue) == 2233 and len({r["work_id"] for r in queue}) == 84,
            "sealed_scope_not_84_2233")
    totals = report["by_cohort"]["wave_a"]["partitions"]["deferred_source_or_policy"]
    require(totals["works"] == 84 and totals["windows"] == 2233, "report_scope_mismatch")
    frozen = {}
    for name, digest in manifest["audit_pins"].items():
        ref = {"path": str(inputs.path(manifest["audit_dir"]) / name), "sha256": digest}
        if name == "input_hashes.jsonl":
            frozen = {inputs.path(r["path"]).as_posix(): r for _, r, _ in inputs.rows(ref)}
        elif name == "report.json":
            original_report = inputs.load(ref)
        else:
            inputs.verify(ref)
    read_pins = {inputs.path(r["path"]).as_posix(): r for r in manifest["actual_read_inputs"]}
    inputs.historical_pins = frozen
    works = defaultdict(list)
    identities = set()
    for row in queue:
        require(row["decision"] == "deferred_source_or_policy", "nondeferred_row")
        work = row["work_id"]
        identity = (work, row["window_id"])
        require(identity not in identities, "duplicate_inventory_window")
        identities.add(identity)
        for ref in [*row["artifacts"].values(), *row["audited_sentence_aliases"]]:
            key = inputs.path(ref["path"]).as_posix()
            require(key in read_pins and read_pins[key]["sha256"] == ref["sha256"],
                    "artifact_not_inventory_pinned")
            require(key in frozen and frozen[key]["sha256"] == ref["sha256"],
                    "artifact_not_original_audit_pinned")
        works[work].append(row)
    for work, windows in works.items():
        refs = windows[0]["artifacts"]
        require(all(r["artifacts"] == refs for r in windows), "multiple_work_artifact_sets")
        require(all(r["audited_sentence_aliases"] == windows[0]["audited_sentence_aliases"] for r in windows),
                "multiple_work_source_alias_sets")
        for label, role in (("sentences.jsonl", "sentences"),
                            ("coverage_partition.jsonl", "coverage")):
            provenance = [r for r in original_report["historical_input_hash_checks"]
                          if r["work"] == work and r["label"] == label]
            require(len(provenance) == 1, "missing_original_provenance")
            p = provenance[0]
            require(p["recorded_sha256"] == refs[role]["sha256"], "historical_hash_mismatch")
            candidates = p["matching_paths"] if role == "sentences" else [p["path"]]
            require(inputs.path(refs[role]["path"]) in [inputs.path(x) for x in candidates],
                    "historical_path_mismatch")
        require(report["by_work"][work]["partitions"]["deferred_source_or_policy"]["windows"]
                == len(windows), "work_window_count_mismatch")
    return works


def metadata_dirs(inputs, work, source):
    work_dir = inputs.path(Path("runs") / work)
    parent = inputs.path(source["path"]).parent
    require(parent.is_relative_to(work_dir), "foreign_source_directory")
    return [parent, *[p for p in parent.parents if p.is_relative_to(work_dir)]]


def prepare_metadata(inputs, works):
    """Discovery only: exact pinned index directory and its ancestors in that work.

    No sibling source index, external chapter directory guessed from a title, or
    'newest' corpus is eligible. Absence here does not assert global absence.
    """
    records = []
    for work, windows in sorted(works.items()):
        refs = []
        directories = metadata_dirs(inputs, work, windows[0]["artifacts"]["sentences"])
        for directory in directories:
            # Only the exact source index is recursive, never a sibling/newer index.
            candidates = directory.rglob("*") if directory == directories[0] else directory.iterdir()
            for path in sorted(candidates):
                if (path.is_file() and path.suffix in (".json", ".jsonl")
                    and re.search(r"chapter|manifest|metadata|provenance|book|index|record", path.name)):
                    refs.append(file_pin(inputs.path(path)))
        records.append({"work_id": work, "source": windows[0]["artifacts"]["sentences"],
                        "searched_exact_directories": [p.as_posix() for p in directories],
                        "metadata": refs})
    preservation = inputs.root / OUT / "prior_partial_preservation.json"
    return {"version": VERSION, "discovery_policy": "recursive_exact_source_index_and_direct_work_ancestors_only",
            "evidence_limit": "No external chapter provenance path declared by these documents is assumed. "
                              "No sibling or newer corpus searched; absence is bounded to listed paths.",
            "works": records, "boundaries": BOUNDARIES,
            "prior_partial_preservation": file_pin(preservation) if preservation.is_file() else None}


def metadata_fields(value, path, pointer="", chapter_context=False, source_context=None):
    """Emit identity fields only, never chapter titles, sentence text or prose.

    A relation is two fields of the SAME explicit book/work metadata object.
    Chapter-code prefixes and directory/job titles are not relations.
    """
    fields, relations = [], []
    if isinstance(value, list):
        for index, child in enumerate(value):
            f, r = metadata_fields(child, path, pointer + "/" + str(index), chapter_context, source_context)
            fields.extend(f)
            relations.extend(r)
    elif isinstance(value, dict):
        chapter = chapter_context or "chapter_id" in value or "sentence_id" in value or "source_chapter_id" in value
        source_context = list(source_context or [])
        for key in ("source", "source_snapshot", "sentence_source", "original_source"):
            ref = value.get(key)
            if isinstance(ref, dict) and isinstance(ref.get("path"), str) and isinstance(ref.get("sha256"), str):
                source_context.append({"path": ref["path"], "sha256": ref["sha256"],
                                       "path_pointer": pointer + "/" + key + "/path",
                                       "sha256_pointer": pointer + "/" + key + "/sha256"})
        if isinstance(value.get("source_path"), str) and isinstance(value.get("source_sha256"), str):
            source_context.append({"path": value["source_path"], "sha256": value["source_sha256"],
                                   "path_pointer": pointer + "/source_path", "sha256_pointer": pointer + "/source_sha256"})
        codes = ("code", "book_code", "work_code", "book_id", "work_id", "local_work_id", "bookkey", "book_key")
        titles = ("book_title", "work_title", "book_name", "work_name", "novel", "novel_name")
        if not chapter:
            titles += ("title", "name", "book")
        code_fields = [(k, value[k]) for k in codes if isinstance(value.get(k), str)]
        title_fields = [(k, value[k]) for k in titles if isinstance(value.get(k), str)]
        for key, item in code_fields + title_fields:
            fields.append({"path": path, "pointer": pointer + "/" + key, "value": item,
                           "kind": "code_or_identifier" if key in codes else "declared_book_title"})
        if not chapter:
            for ck, code in code_fields:
                for tk, title in title_fields:
                    relations.append({"path": path, "code_pointer": pointer + "/" + ck,
                                      "code": code, "title_pointer": pointer + "/" + tk, "title": title,
                                      "source_snapshot_references": source_context})
        for key, child in value.items():
            # chapter_kv keys are explicit chapter IDs; do not treat its title as a book.
            if isinstance(child, (dict, list)):
                escaped = key.replace("~", "~0").replace("/", "~1")
                f, r = metadata_fields(child, path, pointer + "/" + escaped,
                                       chapter or key in ("chapters", "chapter_kv") or bool(re.fullmatch(r"[^:]+:C\d+", key)),
                                       source_context)
                fields.extend(f)
                relations.extend(r)
    return fields, relations


def scan_sentences(inputs, ref, wanted):
    cache_key = (inputs.path(ref["path"]).as_posix(), "sentences")
    if cache_key in inputs.cache:
        cached_wanted, result = inputs.cache[cache_key]
        inputs.verify(ref)
        require(cached_wanted == wanted, "sentence_cache_scope_mismatch")
        return result
    frequencies, selected_freq, prefixes, chapter_freq = Counter(), Counter(), Counter(), Counter()
    ids, selected = Counter(), defaultdict(list)
    missing_ids = missing_work = prefix_mismatch = missing_chapter = id_chapter_mismatch = 0
    total = 0
    line_runs = defaultdict(list)
    chapter_runs = defaultdict(list)
    sentence_line_runs = []
    for line, row, row_hash in inputs.rows(ref, stream_only=True):
        total += 1
        local = row.get("work_id")
        label = "<missing>" if local is None else str(local)
        frequencies[label] += 1
        runs = line_runs[label]
        if runs and runs[-1][1] == line - 1:
            runs[-1][1] = line
        else:
            runs.append([line, line])
        missing_work += local is None
        sid, chapter = row.get("sentence_id"), row.get("chapter_id")
        if isinstance(sid, str):
            ids[sid] += 1
        else:
            missing_ids += 1
        suffix = re.fullmatch(r"(.*?)(\d+)", sid) if isinstance(sid, str) else None
        if suffix:
            prefix, number, width = suffix[1], int(suffix[2]), len(suffix[2])
            previous = sentence_line_runs[-1] if sentence_line_runs else {}
            if (previous.get("identifier_prefix") == prefix and previous.get("numeric_width") == width
                    and previous["last"] + 1 == number and previous["last_line"] + 1 == line):
                previous.update(last=number, last_line=line)
            else:
                sentence_line_runs.append(dict(identifier_prefix=prefix, numeric_width=width,
                    first=number, last=number, first_line=line, last_line=line))
        else:
            sentence_line_runs.append(dict(sentence_id=sid, first_line=line, last_line=line))
        if isinstance(chapter, str) and ":" in chapter:
            prefix = chapter.split(":", 1)[0]
            prefixes[prefix] += 1
            chapter_freq[chapter] += 1
            runs = chapter_runs[chapter]
            if runs and runs[-1][1] == line - 1:
                runs[-1][1] = line
            else:
                runs.append([line, line])
            if local is not None and prefix != local:
                prefix_mismatch += 1
            if isinstance(sid, str) and not sid.startswith(chapter + ":"):
                id_chapter_mismatch += 1
        else:
            missing_chapter += 1
        if sid in wanted:
            selected_freq[label] += 1
            selected[sid].append({"line": line, "row_sha256": row_hash,
                                  "work_id": local, "chapter_id": chapter})
    frequency_runs = []
    for sid, count in sorted(ids.items()):
        suffix = re.fullmatch(r"(.*?)(\d+)", sid)
        previous = frequency_runs[-1] if frequency_runs else {}
        if suffix:
            prefix, number, width = suffix[1], int(suffix[2]), len(suffix[2])
            if (previous.get("identifier_prefix") == prefix and previous.get("numeric_width") == width
                    and previous.get("occurrences_per_identifier") == count and previous["last"] + 1 == number):
                previous["last"] = number
            else:
                frequency_runs.append(dict(identifier_prefix=prefix, numeric_width=width,
                    first=number, last=number, occurrences_per_identifier=count))
        else:
            frequency_runs.append(dict(sentence_id=sid, occurrences_per_identifier=count))
    result = dict(total_rows=total, observed_work_id_frequencies=dict(sorted(frequencies.items())),
                  selected_work_id_frequencies=dict(sorted(selected_freq.items())),
                  chapter_prefix_frequencies=dict(sorted(prefixes.items())),
                   chapter_frequencies=dict(chapter_freq), selected=dict(selected),
                   work_id_line_ranges=dict(sorted(line_runs.items())),
                   chapter_id_line_ranges=dict(sorted(chapter_runs.items())),
                   sentence_id_multiplicity_histogram=dict(sorted(Counter(ids.values()).items())),
                   distinct_sentence_id_count=len(ids), full_forward_scans=1,
                   sentence_id_frequency_ranges=frequency_runs,
                   sentence_id_line_distribution=sentence_line_runs,
                   identifier_range_encoding="Inclusive numeric suffix ranges, zero-padded to numeric_width; singletons literal. "
                       "Lossless counts and every physical row location, including duplicate occurrences; no row collapse.",
                  missing_work_id_rows=missing_work, missing_sentence_id_rows=missing_ids,
                  missing_chapter_id_rows=missing_chapter, chapter_prefix_mismatch_rows=prefix_mismatch,
                  sentence_id_chapter_mismatch_rows=id_chapter_mismatch,
                  duplicate_sentence_id_count=sum(n > 1 for n in ids.values()),
                  duplicate_extra_row_count=sum(n - 1 for n in ids.values() if n > 1),
                  selected_duplicate_sentence_id_count=sum(len(v) > 1 for v in selected.values()),
                  selected_duplicate_extra_row_count=sum(len(v) - 1 for v in selected.values() if len(v) > 1),
                  missing_selected_sentence_id_count=len(wanted - selected.keys()))
    inputs.cache[cache_key] = (wanted, result)
    return result


def classify(work, scan, relations, fields, mismatches, incomplete):
    observed = set(scan["observed_work_id_frequencies"]) - {"<missing>"}
    declared = {r["code"] for r in relations}
    wrong = [r for r in relations if r["title"] != work and r["code"] in observed]
    matching = [r for r in relations if r["title"] == work and r["code"] in observed
                and r.get("exact_source_snapshot_match", False)]
    proof = {r["code"] for r in matching}
    conflicts = list(mismatches)
    if wrong:
        conflicts.append("metadata_code_declares_different_title")
    if any(f["kind"] == "declared_book_title" and f["value"] != work for f in fields):
        conflicts.append("crosswork_title_declaration")
    if relations and (observed - declared):
        conflicts.append("observed_code_absent_from_declared_namespace")
    if len(observed) > 1:
        conflicts.append("multiple_observed_work_identifiers")
    if declared - observed:
        incomplete.append("declared_codes_not_observed_in_pinned_source")
    if scan["chapter_prefix_mismatch_rows"]:
        conflicts.append("sentence_work_id_vs_chapter_prefix_mismatch")
    if scan["sentence_id_chapter_mismatch_rows"]:
        conflicts.append("sentence_id_vs_chapter_id_mismatch")
    if scan["missing_work_id_rows"] or scan["missing_chapter_id_rows"]:
        incomplete.append("missing_sentence_namespace_fields")
    if scan["missing_selected_sentence_id_count"]:
        incomplete.append("selected_sentence_ids_missing")
    if conflicts:
        status = "conflicting_identity"
    elif not incomplete and observed and proof == observed:
        status = "supported_local_namespace_mapping"
    elif not incomplete and len(observed) == 1 and scan["chapter_prefix_frequencies"] and (
            observed == set(scan["chapter_prefix_frequencies"])):
        status = "mapping_candidate_needs_approval"
    else:
        status = "unresolved"
    interpretation = {}
    for local in sorted(observed):
        if local == work:
            interpretation[local] = "literal_title_identifier_not_global_alias_proof"
        elif local in proof and not wrong:
            interpretation[local] = "upstream_declared_local_book_code"
        elif re.fullmatch(r"B\d+", local):
            interpretation[local] = "code_shaped_identifier_title_relationship_unproven"
        else:
            interpretation[local] = "unknown_identifier_not_assumed_title_or_code"
    if scan["missing_work_id_rows"]:
        interpretation["<missing>"] = "missing"
    return status, sorted(set(conflicts)), sorted(set(incomplete)), interpretation


def audit_work(inputs, work, windows, metadata):
    refs = windows[0]["artifacts"]
    # ALL original source hashes must verify before namespace reasoning.
    for ref in [*[v for k, v in refs.items() if k != "sentences"], *metadata["metadata"]]:
        inputs.verify(ref)
    job = inputs.load(refs["job"])
    require(job.get("book") == work, "job_book_mismatch")
    for label, role in (("sentences.jsonl", "sentences"), ("coverage_partition.jsonl", "coverage")):
        require(job["input_artifact_hashes"][label] == refs[role]["sha256"], "job_pin_mismatch")
    wanted_windows = {w["window_id"] for w in windows}
    coverage, generator = defaultdict(list), defaultdict(list)
    for label, index in (("coverage", coverage), ("generator", generator)):
        for line, row, row_hash in inputs.rows(refs[label]):
            if row.get("window_id") in wanted_windows:
                # Do not retain generator responses, cards, or any source prose.
                index[row["window_id"]].append({k: row.get(k) for k in (
                    "work_id", "chapter_id", "sentence_ids", "anchor_sentence_ids",
                    "attached_sentence_ids", "role")} | {"line": line, "row_sha256": row_hash})
    selected_ids = set()
    mismatches, incomplete = [], []
    per_window = []
    for window in windows:
        wid = window["window_id"]
        c, g = coverage[wid], generator[wid]
        if len(c) != 1 or len(g) != 1:
            incomplete.append("missing_or_ambiguous_coverage_generator_window")
            continue
        c, g = c[0], g[0]
        for label, row, locs in (("coverage", c, [window["coverage_row"]]),
                                 ("generator", g, window["generator_rows"])):
            require(locs and all(loc["line"] == row["line"] and loc["row_sha256"] == row["row_sha256"]
                                and loc["file_sha256"] == refs[label]["sha256"]
                                and inputs.path(loc["path"]) == inputs.path(refs[label]["path"]) for loc in locs),
                    "inventory_row_reference_mismatch")
        ids = c["anchor_sentence_ids"] + c["attached_sentence_ids"]
        selected_ids.update(ids)
        if any(row["work_id"] not in (None, work) for row in (c, g)):
            mismatches.append("foreign_coverage_or_generator_work")
        if c["chapter_id"] != g["chapter_id"] or c["chapter_id"] != window["chapter_id"]:
            mismatches.append("window_chapter_mismatch")
        if g["sentence_ids"] != ids:
            mismatches.append("generator_coverage_sentence_selection_mismatch")
        require(window["sentence_ids"] == g["sentence_ids"], "inventory_sentence_selection_mismatch")
        require(window["original_execution_input_pins"] == job["input_artifact_hashes"], "inventory_job_pins_mismatch")
        if g["role"] != c["role"] or c["role"] not in job.get("roles", ["rule_atom_read"]):
            mismatches.append("generator_coverage_job_role_mismatch")
        per_window.append((window, ids))
    scan = scan_sentences(inputs, refs["sentences"], selected_ids)
    for ref in windows[0]["audited_sentence_aliases"]:
        inputs.verify(ref)
    affected, missing_windows, duplicate_windows, chapter_windows = 0, 0, 0, 0
    for window, ids in per_window:
        source_locs = [{"path": refs["sentences"]["path"], "file_sha256": refs["sentences"]["sha256"],
                        "line": r["line"], "row_sha256": r["row_sha256"], "sentence_id": sid,
                        "original_work_id": r["work_id"], "original_chapter_id": r["chapter_id"]}
                       for sid in ids for r in scan["selected"].get(sid, [])]
        require(window["sentence_rows"] == source_locs, "inventory_source_row_reference_mismatch")
        matches = [r for sid in ids for r in scan["selected"].get(sid, [])]
        affected += any(r["work_id"] not in (None, work) for r in matches)
        missing_windows += any(sid not in scan["selected"] for sid in ids)
        duplicate_windows += any(len(scan["selected"].get(sid, [])) > 1 for sid in ids)
        chapter_windows += any(r["chapter_id"] != window["chapter_id"] for r in matches)
    if chapter_windows:
        mismatches.append("selected_sentence_chapter_vs_window_mismatch")
    fields, relations, chapter_codes, chapter_ids = [], [], Counter(), set()
    metadata_issues = []
    for ref in metadata["metadata"]:
        path = inputs.path(ref["path"])
        is_chapter = path.name in ("chapters.jsonl", "chapter_kv.json", "chapters.json")
        witnessed_prefixes = set()
        if path.suffix == ".jsonl":
            objects = (("/line/" + str(line), row) for line, row, _ in inputs.rows(ref, metadata_issues))
        else:
            try:
                objects = [("", inputs.load(ref))]
            except ValueError as error:
                if not str(error).startswith("malformed_json:"):
                    raise
                metadata_issues.append({"path": path.as_posix(), "code": "malformed_metadata_json_document"})
                objects = []
        for pointer, obj in objects:
            f, r = metadata_fields(obj, path.as_posix(), pointer, is_chapter)
            for relation in r:
                relation["metadata_sha256"] = ref["sha256"]
                historical = inputs.historical_pins.get(path.as_posix(), {}).get("sha256") == ref["sha256"]
                relation["metadata_historically_pinned"] = historical
                relation["metadata_snapshot_kind"] = "historically_pinned" if historical else "current_offline_pinned_only"
                relation["exact_source_snapshot_match"] = False
                for source_ref in relation["source_snapshot_references"]:
                    try:
                        same_path = inputs.path(source_ref["path"]) == inputs.path(refs["sentences"]["path"])
                    except ValueError:
                        same_path = False
                    source_ref["matches_audited_snapshot"] = same_path and source_ref["sha256"] == refs["sentences"]["sha256"]
                    if same_path and not source_ref["matches_audited_snapshot"]:
                        mismatches.append("metadata_source_snapshot_hash_mismatch")
                    relation["exact_source_snapshot_match"] |= source_ref["matches_audited_snapshot"]
                relation["lineage_fully_confirmed"] = historical and relation["exact_source_snapshot_match"]
            fields.extend(f)
            relations.extend(r)
            if is_chapter:
                entries = (list(obj.items()) if isinstance(obj, dict) and "chapter_id" not in obj
                           else [(None, obj)])
                for key, entry in entries:
                    if isinstance(entry, dict) and isinstance(entry.get("chapter_id"), str):
                        cid = entry["chapter_id"]
                        chapter_ids.add(cid)
                        prefix = cid.split(":", 1)[0]
                        chapter_codes[prefix] += 1
                        if prefix not in witnessed_prefixes:
                            base = pointer if key is None else pointer + "/" + key.replace("~", "~0").replace("/", "~1")
                            for field in ("chapter_id", "chapter_seq", "file", "offset_kind", "source_chapter_id"):
                                if field in entry:
                                    fields.append({"path": path.as_posix(), "pointer": base + "/" + field,
                                                   "value": entry[field], "kind": "chapter_namespace_context_not_book_title_proof"})
                            witnessed_prefixes.add(prefix)
    if metadata_issues:
        incomplete.append("malformed_explicit_metadata")
    if chapter_ids:
        missing_chapters = set(scan["chapter_frequencies"]) - chapter_ids
        if missing_chapters:
            incomplete.append("sentence_chapters_absent_from_explicit_chapter_index")
        if set(chapter_codes) != set(scan["chapter_prefix_frequencies"]):
            mismatches.append("chapter_index_prefix_vs_sentence_prefix_mismatch")
    else:
        incomplete.append("no_explicit_chapter_index")
    status, conflicts, limits, interpretation = classify(work, scan, relations, fields, mismatches, incomplete)
    observed = scan["observed_work_id_frequencies"]
    bindings = [{"key": {"work_id": work, "source_sha256": refs["sentences"]["sha256"],
                           "local_work_id": local}, "target_work_id": work,
                  "status": status, "approved": False, "applied": False,
                  "global_alias": False,
                  "source_row_count": observed[local],
                  "source_line_ranges": scan["work_id_line_ranges"][local],
                  "selected_row_count": scan["selected_work_id_frequencies"].get(local, 0),
                  "evidence_file": "per_work_bindings.jsonl",
                  "lineage_fully_confirmed": bool(relations) and all(r["lineage_fully_confirmed"] for r in relations)}
                 for local in sorted(observed) if local != "<missing>"]
    summary = {k: v for k, v in scan.items() if k not in ("selected", "chapter_frequencies")}
    summary["chapter_frequencies"] = dict(sorted(scan["chapter_frequencies"].items()))
    # Release selected projections after this work; never hold the full sentence corpus.
    inputs.cache.pop((inputs.path(refs["sentences"]["path"]).as_posix(), "sentences"))
    for ref in metadata["metadata"]:
        inputs.cache.pop(inputs.path(ref["path"]).as_posix(), None)
    return dict(work_id=work, status=status, artifacts=refs,
                original_source_sha256=refs["sentences"]["sha256"],
                audited_sentence_aliases=windows[0]["audited_sentence_aliases"],
                deferred_window_count=len(windows), exact_affected_window_count=affected,
                selected_missing_id_window_count=missing_windows,
                selected_duplicate_id_window_count=duplicate_windows,
                selected_chapter_mismatch_window_count=chapter_windows,
                sentence_distribution=summary, identifier_interpretations=interpretation,
                job_context={"path": refs["job"]["path"], "sha256": refs["job"]["sha256"],
                             "pointer": "/book", "value": job["book"], "title_binding_proof": False},
                declared_metadata_namespace_relation=("explicit_code_title_fields_present" if relations
                                                      else "no_explicit_code_title_relationship_in_pinned_metadata"),
                metadata_refs=metadata["metadata"], exact_relevant_structured_fields=fields,
                 metadata_parse_issues=metadata_issues,
                 upstream_code_title_relationships=relations,
                 metadata_snapshot_qualification="Current metadata pins do not establish historical presence or original-source lineage.",
                 lineage_fully_confirmed=bool(relations) and all(r["lineage_fully_confirmed"] for r in relations),
                 selected_sentence_identifier_locations=scan["selected"],
                 window_identifier_selections=[{"window_id": w["window_id"], "sentence_ids": ids,
                                                "coverage_row": w["coverage_row"], "generator_rows": w["generator_rows"]}
                                               for w, ids in per_window],
                 retained_inventory_blockers=[{"window_id": w["window_id"],
                     "metadata": {k: v for k, v in w.items() if any(s in k for s in ("block", "duplicate", "reason", "issue"))}}
                     for w in windows],
                chapter_index_distinct_chapter_count=len(chapter_ids),
                chapter_index_prefix_record_frequencies=dict(sorted(chapter_codes.items())),
                conflicts=conflicts, incomplete_evidence=limits,
                evidence_limits=["Directory/work path and job.book are contextual consistency only, not title-binding proof.",
                                 "An absent code/title relationship is not supplied by a B001 chapter prefix.",
                                 "Chapter title fields are not book titles; no chapter or novel prose reproduced.",
                                 "No metadata absence claim outside the exact pinned metadata inventory.",
                                 "Repeated IDs counted only; no duplicate equivalence, selection, or collapse performed.",
                                 "Supported means evidence support only, not authorization or a global B001 alias."],
                proposed_bindings=bindings, boundaries=BOUNDARIES)


def build(inputs, works, metadata_ref, inventory_ref):
    metadata = inputs.load(metadata_ref) if metadata_ref else {
        "version": VERSION, "works": [{"work_id": w, "source": rows[0]["artifacts"]["sentences"],
            "searched_exact_directories": [p.as_posix() for p in metadata_dirs(inputs, w, rows[0]["artifacts"]["sentences"])],
            "metadata": []} for w, rows in sorted(works.items())], "boundaries": BOUNDARIES}
    if metadata.get("prior_partial_preservation"):
        inputs.verify(metadata["prior_partial_preservation"])
    records = {r["work_id"]: r for r in metadata["works"]}
    require(len(records) == len(metadata["works"]) and records.keys() == works.keys(), "metadata_scope_mismatch")
    evidence = []
    for work, windows in sorted(works.items()):
        record = records[work]
        require(record["source"] == windows[0]["artifacts"]["sentences"], "metadata_source_pin_mismatch")
        allowed = metadata_dirs(inputs, work, record["source"])
        require(record["searched_exact_directories"] == [p.as_posix() for p in allowed], "metadata_directory_mismatch")
        for ref in record["metadata"]:
            path = inputs.path(ref["path"])
            require(path.parent in allowed or path.is_relative_to(allowed[0]), "foreign_work_metadata")
        evidence.append(audit_work(inputs, work, windows, record))
    counts = {status: {"works": sum(e["status"] == status for e in evidence),
                       "windows": sum(e["deferred_window_count"] for e in evidence if e["status"] == status)}
              for status in STATUSES}
    report = dict(version=VERSION, inventory=inventory_ref, metadata_inventory=metadata_ref,
                  exact_scope={"works": len(evidence), "deferred_windows": sum(len(v) for v in works.values())},
                  counts=counts, boundaries=BOUNDARIES,
                  upstream_code_title_relationship_count=sum(len(e["upstream_code_title_relationships"]) for e in evidence),
                  identifier_interpretation_work_counts=dict(sorted(Counter(
                      interpretation for e in evidence for interpretation in set(e["identifier_interpretations"].values())).items())),
                  observed_work_id_row_frequencies=dict(sorted(sum((Counter(e["sentence_distribution"]["observed_work_id_frequencies"])
                                                                   for e in evidence), Counter()).items())),
                  exact_affected_windows=sum(e["exact_affected_window_count"] for e in evidence),
                   duplicate_flags={"works": sum(e["sentence_distribution"]["duplicate_sentence_id_count"] > 0 for e in evidence),
                                    "selected_windows": sum(e["selected_duplicate_id_window_count"] for e in evidence),
                                    "equivalence_audited": False, "rows_collapsed": False},
                   full_source_scan={"files": len(evidence), "streaming_passes": sum(e["sentence_distribution"]["full_forward_scans"] for e in evidence),
                       "rows": sum(e["sentence_distribution"]["total_rows"] for e in evidence),
                       "scope": "Every row of every pinned sentence file, not samples or deferred selections only",
                       "hash_verification": "SHA256 during the single parse pass; file stat identity guarded until completion"},
                   verified_inventory_references={"job_generator_coverage_source_pins": True,
                       "coverage_generator_row_paths_lines_hashes": True, "all_selected_source_row_paths_lines_hashes": True},
                   prior_partial_preservation=metadata.get("prior_partial_preservation"),
                   metadata_historical_qualification="Support requires structured exact-code/title mapping and an exact source snapshot reference. "
                       "Current-only metadata can support that limited relation, not fully confirmed historical lineage. "
                       "Title/path/job context or metadata without a matching source pin cannot establish supported mapping.",
                   lineage_fully_confirmed_work_count=sum(e["lineage_fully_confirmed"] for e in evidence),
                   per_work_metadata_file_counts={e["work_id"]: len(e["metadata_refs"]) for e in evidence},
                  blockers=["All 2233 windows remain deferred; this audit authorizes no remapping or release.",
                            "Candidate/unresolved mappings need explicit upstream code/title proof or separate approval.",
                            "Duplicate sentence IDs remain a separate audit; no equivalence findings here.",
                            "No quality, promotion, runtime, or schema-gate decision is made."],
                  by_work=[{k: e[k] for k in ("work_id", "status", "deferred_window_count",
                                            "exact_affected_window_count", "conflicts", "incomplete_evidence")}
                           for e in evidence])
    example = next((e for e in evidence if e["upstream_code_title_relationships"]), evidence[0])
    report["example_upstream_evidence"] = {
        "work_id": example["work_id"], "original_source_sha256": example["original_source_sha256"],
        "metadata_refs": example["metadata_refs"],
        "exact_relevant_structured_fields": example["exact_relevant_structured_fields"],
        "observed_work_id_frequencies": example["sentence_distribution"]["observed_work_id_frequencies"],
        "selected_work_id_frequencies": example["sentence_distribution"]["selected_work_id_frequencies"],
        "upstream_code_title_relationships": example["upstream_code_title_relationships"],
         "conclusion": ("See exact structured mapping and snapshot/historical qualifications."
                        if example["upstream_code_title_relationships"] else
                        "Chapter namespace consistency only; no code/title relationship may be inferred from paths or job.book.")}
    sidecar = dict(version=VERSION, binding_key=["work_id", "source_sha256", "local_work_id"],
                   proposal_only=True, bindings=[b for e in evidence for b in e["proposed_bindings"]],
                   boundaries=BOUNDARIES)
    md = ["# Offline Source Namespace Binding Audit", "", "Proposal only. All 2233 deferred windows remain deferred.",
          "No global B001 alias; bindings are keyed by work, exact source SHA256, and local identifier.", "",
          "| Status | Works | Windows |", "| --- | ---: | ---: |"]
    md += [f"| {s} | {n['works']} | {n['windows']} |" for s, n in counts.items()]
    md += ["", "## Evidence Limits", "", *["- " + b for b in report["blockers"]], "",
           "- Directory names and job.book do not prove a code/title relationship.",
           "- Only explicit metadata fields in the frozen exact-path inventory are used.",
           "- Full sentence-file distributions and selected IDs are checked without rewriting rows.",
            "- Missing evidence is reported separately from observed identity/chapter mismatches.", "",
            "- " + report["metadata_historical_qualification"], "",
           "## Exact Upstream Example", "", "```json",
           encoded(report["example_upstream_evidence"]).decode("utf-8").rstrip(), "```", "",
           "## Per Work", "", "| Work | Status | Deferred | Affected |", "| --- | --- | ---: | ---: |"]
    md += [f"| {e['work_id']} | {e['status']} | {e['deferred_window_count']} | {e['exact_affected_window_count']} |" for e in evidence]
    outputs = {"per_work_bindings.jsonl": b"".join(json.dumps(e, ensure_ascii=False, sort_keys=True,
               separators=(",", ":"), allow_nan=False).encode("utf-8") + b"\n" for e in evidence),
                "mapping_proposals.json": encoded(sidecar), "report.json": encoded(report),
                "metadata_inventory.json": encoded(metadata),
               "report.md": ("\n".join(md) + "\n").encode("utf-8")}
    inputs.verify(file_pin(Path(__file__).resolve()))
    test_path = inputs.root / "tests/test_source_namespace_bindings.py"
    inputs.verify(file_pin(test_path))
    inputs.recheck()
    manifest = dict(version=VERSION, script=file_pin(Path(__file__).resolve()),
                    tests=file_pin(test_path), inventory=inventory_ref, metadata_inventory=metadata_ref,
                    boundaries=BOUNDARIES, inputs=sorted(inputs.observed.values(), key=lambda r: r["path"]),
                    outputs={name: {"sha256": sha(data), "bytes": len(data)} for name, data in outputs.items()},
                    materialization="absent_only_exclusive_create", check="external_manifest_sha256_and_byte_reproduction",
                    exact_scope=report["exact_scope"])
    outputs["manifest.json"] = encoded(manifest)
    return outputs, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--prepare-metadata", action="store_true")
    mode.add_argument("--materialize", choices=("newabsent",))
    mode.add_argument("--check", choices=("newaudit",))
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--manifest-sha256", required=True)
    parser.add_argument("--metadata-inventory", type=Path)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--metadata-sha256")
    parser.add_argument("--audit-manifest-sha256")
    args = parser.parse_args()
    inputs = Inputs(ROOT)
    require(args.manifest_sha256 == SEALED, "wrong_external_sealed_inventory_pin")
    inventory = {"path": inputs.path(args.inventory / "manifest.json").as_posix(), "sha256": args.manifest_sha256}
    works = load_scope(inputs, inventory["path"], inventory["sha256"])
    output = inputs.path(args.out_dir)
    require(output.is_relative_to(ROOT / OUT), "output_outside_owned_namespace_audit")
    metadata_path = output / "metadata_inventory.json"
    if args.prepare_metadata:
        require(not output.exists(), "output_directory_already_exists")
        metadata = prepare_metadata(inputs, works)
        inputs.recheck()
        require(output.parent.is_dir(), "output_parent_missing")
        output.mkdir()
        with metadata_path.open("xb") as handle:
            handle.write(encoded(metadata))
        print(json.dumps({"metadata_inventory": file_pin(metadata_path),
                          "works": len(metadata["works"]),
                          "metadata_files": sum(len(r["metadata"]) for r in metadata["works"])}, ensure_ascii=False))
        return
    require(bool(args.metadata_inventory) == bool(args.metadata_sha256), "explicit_metadata_path_and_pin_required_together")
    metadata_ref = ({"path": inputs.path(args.metadata_inventory).as_posix(), "sha256": args.metadata_sha256}
                    if args.metadata_inventory else None)
    if args.materialize:
        require(not output.exists(), "output_directory_already_exists")
        require(output.parent.is_dir(), "output_parent_missing")
    if args.check:
        require(args.audit_manifest_sha256, "external_output_manifest_pin_required")
        inputs.verify({"path": str(output / "manifest.json"), "sha256": args.audit_manifest_sha256})
        # Output is not an input to byte reproduction.
        inputs.observed.pop((output / "manifest.json").as_posix())
    outputs, report = build(inputs, works, metadata_ref, inventory)
    if args.materialize:
        output.mkdir()
        for name, data in outputs.items():
            with (output / name).open("xb") as handle:
                handle.write(data)
    elif args.check:
        require({p.name for p in output.iterdir()} == set(outputs), "unexpected_output_file_set")
        for name, data in outputs.items():
            require((output / name).read_bytes() == data, "output_not_reproducible:" + name)
    print(json.dumps({"mode": "check" if args.check else "materialize" if args.materialize else "dry_run",
                      "counts": report["counts"], "manifest_sha256": sha(outputs["manifest.json"])}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError) as error:
        print("audit_failed: " + str(error), file=sys.stderr)
        sys.exit(1)
