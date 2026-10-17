#!/usr/bin/env python3
"""Deterministic offline window inventory. No runner imports or request construction.

Dry-run is the default. Materialization is exclusive-create; check is read-only.
Only exact audit-report provenance paths and inventory-pinned files are inspected.
"""
from __future__ import annotations

import argparse
import ast
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import re
import sys
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parents[1]
CORE = Path(__file__).resolve().with_name("proposition_canary_run.py")
BUILDER = Path(__file__).resolve()
PARTITIONS = ("regeneration_candidate_8000", "offline_disposition_no_generation",
              "deferred_source_or_policy")
QUEUE_FILES = ("regeneration_windows_8000.jsonl", "offline_disposition_windows.jsonl",
               "deferred_windows.jsonl")
BOUNDARIES = {"publication_status": "candidate_not_confirmed", "transfer_policy": "no_transfer",
              "no_runtime_effect": True, "effective_status": "unknown", "dispatch_authorized": False,
              "quality_certified": False, "semantic_certification": False}


def require(value, reason):
    if not value:
        raise ValueError(reason)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2,
                       allow_nan=False) + "\n").encode("utf-8")


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                      allow_nan=False).encode("utf-8")


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
    value = json.loads(data, object_pairs_hook=pairs, parse_constant=constant)
    canonical(value)
    return value


def families(errors):
    # Diagnostics are codes only, never arbitrary model field names or prose.
    return sorted({code.split(":", 1)[0] if isinstance(code, str)
                   and re.fullmatch(r"[a-z_]+", code.split(":", 1)[0])
                   else "unrecognized_error_code" for code in errors})


def file_hash(path):
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


class Inputs:
    """Read once, retain metadata only across books, rehash before any output write."""

    def __init__(self, root):
        self.root = Path(root).resolve()
        self.observed = {}
        self.cache = {}

    def path(self, text):
        require(isinstance(text, str) and bool(text), "missing_path")
        text = text.replace("\\", "/")
        mounted = re.fullmatch(r"/mnt/([A-Za-z])/(.+)", text)
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
                require(not (getattr(node.lstat(), "st_file_attributes", 0) & 0x400), "symlink_or_junction")
        return path

    def pin(self, path):
        return self.observed[self.path(str(path)).as_posix()]

    def read(self, path, expected=None):
        path = self.path(str(path))
        key = path.as_posix()
        if key not in self.cache:
            data = path.read_bytes() if path.is_file() else None
            self.observed[key] = {"path": key, "sha256": digest(data) if data is not None else None,
                                  "bytes": len(data) if data is not None else None}
            self.cache[key] = data
        data = self.cache[key]
        require(data is not None, "missing_source")
        require(expected is None or digest(data) == expected, "source_hash_mismatch")
        return data

    def rows(self, path, expected, id_key, wanted=None):
        """Stream and parse once, retaining only selected IDs (including duplicates)."""
        path = self.path(str(path))
        key = path.as_posix()
        cache_key = (key, id_key)
        if cache_key not in self.cache:
            if not path.is_file():
                self.observed[key] = {"path": key, "sha256": None, "bytes": None}
                raise ValueError("missing_source")
            index = defaultdict(list)
            h, size, malformed = hashlib.sha256(), 0, False
            with path.open("rb") as handle:
                for line, raw_line in enumerate(handle, 1):
                    h.update(raw_line)
                    size += len(raw_line)
                    raw = raw_line.rstrip(b"\r\n")
                    if not raw.strip():
                        continue
                    try:
                        row = strict(raw)
                        require(isinstance(row, dict), "jsonl_not_object")
                        identity = row.get(id_key)
                        require(isinstance(identity, str), "unresolved_source_id")
                        if wanted is None or identity in wanted:
                            loc = {"path": key, "line": line, "row_sha256": digest(raw)}
                            index[identity].append((row, loc))
                    except (ValueError, TypeError, UnicodeError):
                        malformed = True
            self.observed[key] = {"path": key, "sha256": h.hexdigest(), "bytes": size}
            for items in index.values():
                for _, loc in items:
                    loc["file_sha256"] = h.hexdigest()
            self.cache[cache_key] = (index, malformed)
        index, malformed = self.cache[cache_key]
        require(self.observed[key]["sha256"] == expected, "source_hash_mismatch")
        require(not malformed, "malformed_source_record")
        return index

    def release(self):
        self.cache.clear()

    def recheck(self):
        for key, pin in sorted(self.observed.items()):
            path = self.path(key)
            actual = file_hash(path) if path.is_file() else None
            require(actual == pin["sha256"], "input_changed_during_build:" + key)


def load_core(data):
    """Compile a fixed pure-function AST slice, never execute/import the runner."""
    constants = {"PRIMARY_ROUTES", "ASSERTION_STATUS", "TEMPORAL_STATUS", "EVIDENCE_DIRECTNESS",
                 "GENERALITY_SCOPE", "CARD_KEYS", "MAX_CARDS_PER_WINDOW"}
    functions = {"strict_json", "parse_strict", "build_window", "validate_card"}
    nodes = []
    for node in ast.parse(data).body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            if isinstance(target, ast.Name) and target.id in constants:
                ast.literal_eval(node.value)
                nodes.append(node)
        elif isinstance(node, ast.FunctionDef) and node.name in functions:
            require(not node.decorator_list, "unexpected_core_decorator")
            nodes.append(node)
    require(len(nodes) == len(constants) + len(functions), "core_slice_incomplete")
    scope = {"json": json, "re": re, "Any": Any, "Mapping": Mapping}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(CORE), "exec"), scope)
    return scope


class Builder:
    def __init__(self, root, audit_dir, pins):
        self.inputs = Inputs(root)
        self.audit_dir = self.inputs.path(str(audit_dir))
        self.pins = pins
        self.inventory = {}
        self.report = {}
        self.windows = []
        self.entries = []

    def artifact(self, path, expected=None):
        resolved = self.inputs.path(path)
        relative = resolved.relative_to(self.inputs.root).as_posix()
        item = self.inventory.get(relative)
        require(item is not None, "source_not_in_audit_inventory")
        require(expected is None or expected == item["sha256"], "original_pin_conflict")
        return {"path": resolved.as_posix(), "sha256": item["sha256"]}

    def provenance(self, work, label):
        rows = [r for r in self.report["historical_input_hash_checks"]
                if r["work"] == work and r["label"] == label]
        require(len(rows) == 1, "ambiguous_or_missing_provenance")
        return rows[0]

    def book(self, work, entries, core, audit_manifest):
        inputs = self.inputs
        blockers, refs, source_aliases = [], {}, []
        gen_index, coverage, sentences = {}, {}, {}
        job, source_pins = {}, {}
        try:
            gp_paths = {r[1]["attempt_artifact"]["path"] for r in entries}
            require(len(gp_paths) == 1, "ambiguous_generator_artifact")
            gp = next(iter(gp_paths))
            refs["generator"] = self.artifact(gp)
            # The original job is the inventory-pinned sibling of the exact audited generator.
            refs["job"] = self.artifact(str(inputs.path(gp).with_name("job_record.json")))
            cp = self.provenance(work, "coverage_partition.jsonl")
            sp = self.provenance(work, "sentences.jsonl")
            source_pins = {"coverage_partition.jsonl": cp["recorded_sha256"],
                           "sentences.jsonl": sp["recorded_sha256"]}
            refs["coverage"] = self.artifact(cp["path"], cp["recorded_sha256"])
            # Persisted WSL aliases were already resolved by the original audit. Do not rediscover.
            candidates = sorted(set(sp.get("matching_paths", [])))
            require(bool(candidates), "missing_audited_sentence_path")
            for path in candidates:
                ref = self.artifact(path, sp["recorded_sha256"])
                source_aliases.append(ref)
            refs["sentences"] = source_aliases[0]
            for ref in source_aliases:
                require(inputs.path(ref["path"]).is_relative_to(inputs.root / "runs" / work),
                        "sentence_path_work_mismatch")
            job = strict(inputs.read(**self.read_args(refs["job"])))
            require(job.get("book") == work, "job_work_mismatch")
            recorded_pins = job.get("input_artifact_hashes", {})
            require(all(recorded_pins.get(label) == sha for label, sha in source_pins.items()),
                    "job_provenance_pin_mismatch")
            source_pins = recorded_pins
            gen_index = inputs.rows(refs["generator"]["path"], refs["generator"]["sha256"], "window_id")
            coverage = inputs.rows(refs["coverage"]["path"], refs["coverage"]["sha256"], "window_id")
            wanted = set()
            for _, entry, _ in entries:
                for row, _ in coverage.get(entry["window_id"], []):
                    wanted.update(row.get("anchor_sentence_ids", []) + row.get("attached_sentence_ids", []))
            sentences = inputs.rows(refs["sentences"]["path"], refs["sentences"]["sha256"],
                                    "sentence_id", wanted)
        except (ValueError, KeyError, TypeError, OSError) as error:
            blockers.append(self.reason(error))

        grouped = defaultdict(list)
        window_pins = defaultdict(set)
        for line, entry, row_hash in entries:
            loc = entry["attempt_artifact"]
            # Missing pins stay null; even deferred groups never invent a source identity.
            key = (work, loc.get("file_sha256"), source_pins.get("coverage_partition.jsonl"),
                   source_pins.get("sentences.jsonl"), entry.get("window_id"))
            grouped[key].append((line, entry, row_hash))
            window_pins[entry.get("window_id")].add(loc.get("file_sha256"))
        for key in sorted(grouped, key=canonical):
            items = grouped[key]
            wid = key[-1]
            hard, needs, observations = list(blockers), [], []
            if len(window_pins[wid]) != 1:
                hard.append("ambiguous_window_generator_pins")
            cohort_values = {e[1].get("cohort") for e in items}
            cohorts = [c for c, works in audit_manifest["cohorts"].items() if work in works]
            if len(cohorts) != 1 or cohort_values != set(cohorts):
                hard.append("cohort_or_work_not_in_audit")
            cohort = cohorts[0] if len(cohorts) == 1 else None
            grow, gloc, cov, cloc, window = {}, {}, {}, {}, None
            source_rows, cards_meta = [], []
            records = gen_index.get(wid, [])
            covs = coverage.get(wid, [])
            if len(records) != 1:
                hard.append("ambiguous_or_missing_generator_window")
            else:
                grow, gloc = records[0]
            if len(covs) != 1:
                hard.append("ambiguous_or_missing_coverage_window")
            else:
                cov, cloc = covs[0]
            chapter = cov.get("chapter_id", grow.get("chapter_id"))
            if grow and cov:
                try:
                    for row in (grow, cov):
                        require(row.get("work_id") in (None, work), "window_work_mismatch")
                    require(grow.get("chapter_id") == cov.get("chapter_id"), "chapter_mismatch")
                    ids = cov.get("anchor_sentence_ids", []) + cov.get("attached_sentence_ids", [])
                    require(grow.get("sentence_ids") == ids, "generator_source_ids_mismatch")
                    require(grow.get("role") == cov.get("role")
                            and cov.get("role") in job.get("roles", ["rule_atom_read"]), "job_window_role_mismatch")
                    bound = {}
                    for sid in ids:
                        matches = sentences.get(sid, [])
                        if len(matches) != 1:
                            hard.append("ambiguous_or_missing_sentence_id")
                            source_rows.extend({**sloc, "sentence_id": sid,
                                                "original_work_id": source.get("work_id"),
                                                "original_chapter_id": source.get("chapter_id")}
                                               for source, sloc in matches)
                            continue
                        source, sloc = matches[0]
                        if source.get("work_id") not in (None, work):
                            hard.append("sentence_work_mismatch")
                        bound[sid] = source
                        source_rows.append({**sloc, "sentence_id": sid,
                                            "original_work_id": source.get("work_id"),
                                            "original_chapter_id": source.get("chapter_id")})
                    if not hard:
                        window = core["build_window"](cov, bound)
                except (ValueError, KeyError, TypeError) as error:
                    hard.append(self.reason(error))

            raw = grow.get("raw_response", "")
            payload, parse_error = core["parse_strict"](raw)
            proposed = payload.get("propositions") if payload is not None else None
            generation_errors = []
            if parse_error:
                generation_errors.append(parse_error)
            elif not isinstance(proposed, list):
                generation_errors.append("propositions_not_list")
            elif len(proposed) > core["MAX_CARDS_PER_WINDOW"]:
                generation_errors.append("generator_card_limit_exceeded")
            meta = grow.get("call_meta") or {}
            if meta.get("http_status") != 200:
                generation_errors.append("transport_not_200")
            if meta.get("finish_reason") != "stop":
                generation_errors.append("finish_reason_not_stop")
            if grow.get("parse_error") and not generation_errors:
                observations.append("recorded_parse_status_mismatch")
            if grow:
                needs.extend(generation_errors)
            cards = grow.get("cards") or []
            if not isinstance(cards, list) or any(not isinstance(c, dict) for c in cards):
                hard.append("malformed_persisted_cards")
                cards = []
            if isinstance(proposed, list) and len(proposed) != len(cards):
                hard.append("raw_persisted_card_count_mismatch")
            card_ids = [c.get("card_id") for c in cards]
            if len(set(card_ids)) != len(card_ids):
                hard.append("ambiguous_card_id")
            if grow.get("proposed_count") != len(cards):
                hard.append("persisted_card_count_mismatch")
            rejected_indices = set()
            per_card_errors = {}
            for index, card in enumerate(cards):
                if (card.get("work_id") not in (None, work)
                        or card.get("window_id") not in (None, wid)
                        or card.get("chapter_id") not in (None, chapter)
                        or card.get("allowed_work_ids", [work]) != [work]):
                    hard.append("card_binding_mismatch")
                if card.get("card_id") != f"{wid}#{index}":
                    hard.append("unresolved_card_id")
                original = card.get("generator_card")
                if isinstance(proposed, list) and (index >= len(proposed) or proposed[index] != original):
                    hard.append("raw_generator_card_mismatch")
                normalized, errors = (core["validate_card"](original, window)
                                      if window is not None else (None, []))
                per_card_errors[index] = families(errors)
                accepted = card.get("accepted_for_verification")
                if accepted not in (True, False) or type(accepted) is not bool:
                    hard.append("invalid_original_accepted_flag")
                if accepted is not True:
                    rejected_indices.add(index)
                    needs.extend(families(errors))
                    if window is not None and not errors:
                        observations.append("rejected_card_now_structurally_valid")
                mismatch = normalized != card.get("normalized_card") if window is not None else None
                if mismatch:
                    observations.append("normalization_mismatch_preserved")
                verifier = card.get("verifier") or {}
                cards_meta.append({"card_index": index, "card_id": card.get("card_id"),
                                   "original_accepted_for_verification": accepted,
                                   "original_schema_error_families": families(card.get("schema_errors") or []),
                                   "original_schema_errors_sha256": digest(canonical(card.get("schema_errors"))),
                                   "generator_card_sha256": digest(canonical(original)),
                                   "normalized_card_sha256": digest(canonical(card.get("normalized_card"))),
                                   "current_card_error_families": families(errors),
                                   "current_card_validation_performed": window is not None,
                                   "normalization_mismatch": mismatch,
                                   "original_entailed_flag": card.get("entailed"),
                                   "original_verifier_status_sha256": digest(canonical(verifier)),
                                   "original_verdict": verifier.get("verdict")
                                   if verifier.get("verdict") in ("entailed", "insufficient", "contradicted") else None})

            queue_targets = Counter((e[1]["kind"], e[1].get("card_id"),
                                     e[1]["attempt_artifact"].get("card_index")) for e in items)
            if any(n > 1 for n in queue_targets.values()):
                hard.append("duplicate_ambiguous_queue_entry")
            queued_indices = set()
            origins = []
            for line, entry, row_hash in items:
                loc = entry["attempt_artifact"]
                if refs.get("generator", {}).get("sha256") != loc.get("file_sha256"):
                    hard.append("queue_generator_pin_mismatch")
                if (gloc.get("line") != loc.get("line") or gloc.get("row_sha256") != loc.get("row_sha256")
                        or digest(raw.encode("utf-8")) != loc.get("raw_response_sha256")):
                    hard.append("queue_generator_row_or_raw_mismatch")
                index = loc.get("card_index")
                if entry["kind"] == "schema_or_span_rejection":
                    if (type(index) is not int or not 0 <= index < len(cards)
                            or cards[index].get("card_id") != entry.get("card_id")):
                        hard.append("queue_card_not_reproduced")
                    else:
                        queued_indices.add(index)
                        if cards[index].get("accepted_for_verification") is not False:
                            observations.append("recorded_accepted_status_mismatch")
                        if entry.get("error_codes") != (cards[index].get("schema_errors") or
                                                         ["rejected_without_error_code"]):
                            observations.append("recorded_schema_status_mismatch")
                elif entry["kind"] != "generator_window" or entry.get("card_id") is not None:
                    hard.append("unknown_queue_kind")
                origins.append({"queue_line": line, "queue_row_sha256": row_hash,
                                "kind": entry["kind"], "card_id": entry.get("card_id"),
                                "original_error_codes": entry.get("error_codes", []),
                                "original_error_families": families(entry.get("error_codes", [])),
                                "generator_locator": loc})
            if rejected_indices != queued_indices:
                hard.append("incomplete_window_rejection_inventory")
            decision = PARTITIONS[2] if hard else PARTITIONS[0] if needs else PARTITIONS[1]
            reasons = sorted(set(hard if hard else needs if needs else ["structurally_valid_or_bookkeeping_only"]))
            group_id = digest(canonical(key))
            row = {"group_id": group_id, "grouping_key": list(key), "work_id": work, "cohort": cohort,
                   "window_id": wid, "chapter_id": chapter, "decision": decision,
                   "reason_codes": reasons, "source_blockers": sorted(set(hard)),
                   "current_need_families": sorted(set(needs)), "observations": sorted(set(observations)),
                   "artifacts": refs, "audited_sentence_aliases": source_aliases,
                   "original_execution_input_pins": source_pins,
                   "generator_rows": [gloc] if gloc else [], "coverage_row": cloc or None,
                   "sentence_ids": grow.get("sentence_ids", []), "sentence_rows": source_rows,
                   "source_work_binding_policy": "Named work must match when recorded; null is bound only by exact "
                   "per-work audited artifact hashes. Local IDs such as B001 are not remapped to named works.",
                   "raw_response_sha256": digest(raw.encode("utf-8")) if grow else None,
                   "originating_entries": origins, "original_cards": cards_meta,
                   "input_rows": len(items), "unique_rejected_cards": len({e[1].get("card_id") for e in items
                                                                        if e[1]["kind"] == "schema_or_span_rejection"}),
                   "bad_window_entries": sum(e[1]["kind"] == "generator_window" for e in items),
                   "total_original_window_cards": len(cards) if grow else None,
                   "rejected_sibling_count": len(rejected_indices) if grow else None,
                   "already_good_sibling_count": sum(c.get("accepted_for_verification") is True for c in cards)
                   if grow else None,
                   "good_sibling_definition": "original accepted flag only; not semantic certification",
                   "max_future_8000_calls_if_explicitly_authorized": int(decision == PARTITIONS[0]),
                   "later_requirement": "Explicit literal-v2 batch approval, then independent card verifier packaging; "
                   "preserve original statuses and normalization mismatches; no repair writes or semantic remapping.",
                   "boundaries": BOUNDARIES}
            self.windows.append(row)
            for origin in origins:
                index = origin["generator_locator"].get("card_index")
                self.entries.append({"queue_line": origin["queue_line"], "queue_row_sha256": origin["queue_row_sha256"],
                                     "queue_file_sha256": self.pins["generator_repair_queue.jsonl"],
                                     "work_id": work, "cohort": cohort, "window_id": wid, "chapter_id": chapter,
                                     "card_id": origin["card_id"], "kind": origin["kind"], "group_id": group_id,
                                     "decision": decision, "reason_codes": reasons,
                                     "original_error_codes": origin["original_error_codes"],
                                     "current_card_error_families": per_card_errors.get(index),
                                     "generator_locator": origin["generator_locator"], "boundaries": BOUNDARIES})

    @staticmethod
    def read_args(ref):
        return {"path": ref["path"], "expected": ref["sha256"]}

    @staticmethod
    def reason(error):
        if isinstance(error, OSError):
            return "source_io_error"
        if isinstance(error, KeyError):
            return "missing_provenance_field"
        if isinstance(error, TypeError):
            return "malformed_source_shape"
        text = str(error).split(":", 1)[0]
        return text if re.fullmatch(r"[a-z_]+", text) else "malformed_source"

    def compile(self):
        inputs = self.inputs
        frozen = {}
        for name in ("manifest.json", "generator_repair_queue.jsonl", "input_hashes.jsonl", "report.json"):
            require(re.fullmatch(r"[0-9a-f]{64}", self.pins.get(name, "")), "external_audit_pin_required:" + name)
            frozen[name] = inputs.read(self.audit_dir / name, self.pins[name])
        audit_manifest = strict(frozen["manifest.json"])
        self.report = strict(frozen["report.json"])
        for raw in frozen["input_hashes.jsonl"].splitlines():
            if raw.strip():
                item = strict(raw)
                require(item["path"] not in self.inventory, "ambiguous_audit_inventory")
                self.inventory[item["path"]] = item
        core_bytes = inputs.read(CORE)
        builder_bytes = inputs.read(BUILDER)
        core = load_core(core_bytes)
        by_work = defaultdict(list)
        input_rows = 0
        for line, raw in enumerate(frozen["generator_repair_queue.jsonl"].splitlines(), 1):
            if not raw.strip():
                continue
            entry = strict(raw)
            require(isinstance(entry, dict) and isinstance(entry.get("work"), str)
                    and isinstance(entry.get("attempt_artifact"), dict), "malformed_audit_queue")
            by_work[entry["work"]].append((line, entry, digest(raw)))
            input_rows += 1
        require(input_rows == self.report["generator_repair_queue_rows"], "audit_queue_count_mismatch")
        for work in sorted(by_work):
            self.book(work, by_work[work], core, audit_manifest)
            inputs.release()
        self.windows.sort(key=lambda r: canonical(r["grouping_key"]))
        self.entries.sort(key=lambda r: r["queue_line"])
        require(len(self.entries) == input_rows and len({e["queue_line"] for e in self.entries}) == input_rows,
                "entry_partition_failed")
        require(len({w["group_id"] for w in self.windows}) == len(self.windows), "window_partition_failed")

        def summary(rows):
            return {"windows": len(rows), "input_rows": sum(r["input_rows"] for r in rows),
                    "unique_rejected_cards": sum(r["unique_rejected_cards"] for r in rows),
                    "bad_window_entries": sum(r["bad_window_entries"] for r in rows),
                    "works": len({r["work_id"] for r in rows}),
                    "windows_with_good_siblings": sum(bool(r["already_good_sibling_count"]) for r in rows),
                    "already_good_siblings": sum(r["already_good_sibling_count"] or 0 for r in rows),
                    "total_original_window_cards": sum(r["total_original_window_cards"] or 0 for r in rows),
                    "windows_with_unresolved_original_card_count": sum(r["total_original_window_cards"] is None for r in rows),
                    "max_future_8000_calls_if_explicitly_authorized": sum(
                        r["max_future_8000_calls_if_explicitly_authorized"] for r in rows)}
        report = {"schema_version": 1, "offline_only": True, "model_calls": 0, "network_calls": 0,
                  "boundaries": BOUNDARIES, "totals": summary(self.windows),
                  "partitions": {p: summary([r for r in self.windows if r["decision"] == p]) for p in PARTITIONS},
                  "by_cohort": {}, "by_work": {}, "by_reason": {},
                  "checks": {"every_entry_exactly_once": True, "unique_window_groups": True,
                             "window_partition_sum": True, "entry_partition_sum": True},
                  "policy": ["Structural classification only; no semantic/noise/worth heuristics.",
                             "A hard blocker defers the complete window; otherwise any need regenerates; else offline.",
                             "Future call bound is a count, not authorization or actual requests.",
                             "Original accepted siblings are not quality facts; no whole-book regeneration.",
                             "No literal regression supersession or equivalence is inferred.",
                             "Current code is separately pinned; historical runner/prompt hashes are not compared to current files.",
                             "Now-valid cards still need later independent card verifier packaging; statuses remain unchanged."]}
        for field, output in (("cohort", "by_cohort"), ("work_id", "by_work")):
            for name in sorted({r[field] for r in self.windows}, key=str):
                rows = [r for r in self.windows if r[field] == name]
                report[output][str(name)] = {"totals": summary(rows), "partitions": {
                    p: summary([r for r in rows if r["decision"] == p]) for p in PARTITIONS}}
        for reason in sorted({reason for r in self.windows for reason in r["reason_codes"]}):
            report["by_reason"][reason] = summary([r for r in self.windows if reason in r["reason_codes"]])
        require(sum(v["windows"] for v in report["partitions"].values()) == len(self.windows), "partition_failed")
        require(sum(v["input_rows"] for v in report["partitions"].values()) == input_rows, "partition_failed")
        report["totals"]["unique_affected_windows"] = len(self.windows)
        report["totals"]["unique_bad_generator_windows"] = sum(r["bad_window_entries"] > 0 for r in self.windows)
        products = {filename: jsonl([r for r in self.windows if r["decision"] == partition])
                    for filename, partition in zip(QUEUE_FILES, PARTITIONS)}
        products["entry_accounting.jsonl"] = jsonl(self.entries)
        products["report.json"] = encoded(report)
        md = ["# Offline Generation Follow-up Inventory", "", "No dispatch authorized. Zero model/network calls.",
              "Structural candidates only; candidate_not_confirmed / no_transfer / no_runtime_effect / effective unknown.",
              "", "## Global Totals", "", "```json", encoded(report["totals"]).decode().rstrip(), "```", "",
              "## Partitions", "", "| Partition | Windows | Rejected cards | Bad window entries | Input rows | Works |",
              "| --- | ---: | ---: | ---: | ---: | ---: |"]
        for p, counts in report["partitions"].items():
            md.append(f"| {p} | {counts['windows']} | {counts['unique_rejected_cards']} | "
                      f"{counts['bad_window_entries']} | {counts['input_rows']} | {counts['works']} |")
        for title, key in (("Cohorts", "by_cohort"), ("Works", "by_work")):
            md += ["", "## " + title, "", "| Name | Regenerate windows/cards | Offline windows/cards | Deferred windows/cards |",
                   "| --- | ---: | ---: | ---: |"]
            for name, item in report[key].items():
                cells = [f"{item['partitions'][p]['windows']}/{item['partitions'][p]['unique_rejected_cards']}"
                         for p in PARTITIONS]
                md.append("| " + " | ".join([name, *cells]) + " |")
        md += ["", "## Reasons (Overlapping)", "", "```json", encoded(report["by_reason"]).decode().rstrip(), "```",
               "", "## Boundaries", "", *report["policy"], ""]
        products["report.md"] = "\n".join(md).encode("utf-8")
        # Rehash even mismatched files read during deferral, and missing-path observations.
        inputs.recheck()
        manifest = {"schema_version": 1, "root": inputs.root.as_posix(), "audit_dir": self.audit_dir.as_posix(),
                    "audit_pins": self.pins, "audit_report_sha256": self.pins["report.json"],
                    "current_core": {"path": CORE.as_posix(), "sha256": digest(core_bytes),
                                     "loading": "pure_function_AST_slice_no_runner_import_or_dispatch",
                                     "functions": ["strict_json", "parse_strict", "build_window", "validate_card"]},
                    "builder": {"path": BUILDER.as_posix(), "sha256": digest(builder_bytes)},
                    "controlled_code_change": "New offline builder only; current validator is not an original execution pin.",
                    "original_execution_code_pins": [r for p, r in sorted(self.inventory.items()) if p.startswith("tools/")],
                    "actual_read_inputs": [v for _, v in sorted(inputs.observed.items())],
                    "outputs": {name: {"sha256": digest(data), "bytes": len(data)} for name, data in sorted(products.items())},
                    "manifest_integrity": "External manifest SHA256 required for check; no circular self hash.",
                    "boundaries": BOUNDARIES, "model_calls": 0, "network_calls": 0,
                    "absent_only": True, "prompts_or_request_bodies_materialized": False}
        products["manifest.json"] = encoded(manifest)
        return products, report


def check_outputs(directory, manifest_sha256, products):
    directory = Path(directory)
    require(re.fullmatch(r"[0-9a-f]{64}", manifest_sha256 or ""), "external_manifest_pin_required")
    require(file_hash(directory / "manifest.json") == manifest_sha256, "output_manifest_hash_mismatch")
    require({p.name for p in directory.iterdir()} == set(products), "output_file_set_mismatch")
    for name, data in products.items():
        require((directory / name).read_bytes() == data, "output_mismatch:" + name)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--audit-dir", type=Path)
    parser.add_argument("--audit-manifest-sha256")
    parser.add_argument("--repair-queue-sha256")
    parser.add_argument("--input-inventory-sha256")
    parser.add_argument("--audit-report-sha256")
    parser.add_argument("--out-dir", type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--materialize", action="store_true")
    mode.add_argument("--check", type=Path)
    parser.add_argument("--manifest-sha256")
    args = parser.parse_args(argv)
    try:
        if args.check:
            require(bool(args.manifest_sha256), "external_manifest_pin_required")
            require(file_hash(args.check / "manifest.json") == args.manifest_sha256, "output_manifest_hash_mismatch")
            existing = strict((args.check / "manifest.json").read_bytes())
            root, audit_dir, pins = Path(existing["root"]), Path(existing["audit_dir"]), existing["audit_pins"]
        else:
            require(args.audit_dir is not None, "audit_dir_required")
            root, audit_dir = args.root, args.audit_dir
            pins = dict(zip(("manifest.json", "generator_repair_queue.jsonl", "input_hashes.jsonl", "report.json"),
                            (args.audit_manifest_sha256, args.repair_queue_sha256,
                             args.input_inventory_sha256, args.audit_report_sha256)))
        if args.materialize:
            require(args.out_dir is not None and not args.out_dir.exists(), "new_absent_output_directory_required")
            require(args.out_dir.parent.is_dir(), "output_parent_required")
            out = Inputs(root).path(str(args.out_dir))
            require(out != audit_dir and not out.is_relative_to(audit_dir), "output_must_not_be_inside_audit")
        products, report = Builder(root, audit_dir, pins).compile()
        if args.check:
            check_outputs(args.check, args.manifest_sha256, products)
        elif args.materialize:
            out.mkdir(exist_ok=False)
            for name, data in sorted(products.items()):
                with (out / name).open("xb") as handle:
                    handle.write(data)
        print(json.dumps({"mode": "check" if args.check else "materialize" if args.materialize else "dry_run",
                          "totals": report["totals"], "partitions": report["partitions"],
                          "by_cohort": report["by_cohort"], "by_reason": report["by_reason"],
                          "manifest_sha256": digest(products["manifest.json"]),
                          "output_hashes": {name: digest(data) for name, data in sorted(products.items())}},
                         ensure_ascii=True, sort_keys=True))
        return 0
    except (ValueError, OSError, KeyError, TypeError) as error:
        print("FAIL: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
