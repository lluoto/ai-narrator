#!/usr/bin/env python3
"""Offline, explicit per-card verifier selection; new review views only."""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys


PARSER_PATH = Path(__file__).resolve().with_name("proposition_canary_run.py")
PARSER_BYTES = PARSER_PATH.read_bytes()
SPEC = importlib.util.spec_from_file_location("effective_selection_canary", PARSER_PATH)
C = importlib.util.module_from_spec(SPEC)
# Loading the parser must not create __pycache__ during a dry run.
exec(compile(PARSER_BYTES, str(PARSER_PATH), "exec"), C.__dict__)
SHA = re.compile(r"[0-9a-f]{64}\Z")
ARTIFACTS = ("generator", "generator_job", "verifier", "verifier_job", "coverage", "sentences")
ENTRY_KEYS = set(ARTIFACTS) | {"work_id", "card_id", "candidate_sha256", "attempt_kind"}
BOUNDARIES = {"no_runtime_effect": True, "quality_certified": False,
              "review_only": True, "cross_work_merge": False, "automatic_promotion_permitted": False}


def canonical_bytes(value):
    """UTF-8, sorted keys, compact separators, ASCII escapes, no trailing newline."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
                      allow_nan=False).encode("utf-8")


def candidate_sha256(card):
    return hashlib.sha256(canonical_bytes(card)).hexdigest()


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def strict_json(content):
    try:
        return C.strict_json(content)
    except RecursionError:
        raise ValueError("json_nesting_too_deep") from None


def absolute_path(value):
    require(isinstance(value, str) and bool(value.strip()) and "\x00" not in value,
            "invalid_path")
    path = Path(value)
    require(path.is_absolute() and ".." not in path.parts, "absolute_nontraversing_path_required")
    return path.resolve()


def pin_shape(ref):
    require(isinstance(ref, dict) and set(ref) == {"path", "sha256"}, "bad_artifact_reference")
    require(isinstance(ref["sha256"], str) and SHA.fullmatch(ref["sha256"]), "invalid_sha256")
    return absolute_path(ref["path"])


def indexed(rows, key):
    result = {}
    for number, row in rows:
        identity = row.get(key)
        require(isinstance(identity, str) and bool(identity.strip()), "invalid_" + key)
        require(identity not in result, "duplicate_" + key)
        result[identity] = (number, row)
    return result


def safe_relative(value):
    require(isinstance(value, str) and "\\" not in value and ":" not in value,
            "unsafe_job_output_path")
    path = PurePosixPath(value)
    require(bool(path.parts) and not path.is_absolute() and path.as_posix() == value
            and all(part not in (".", "..") and not part.endswith((".", " "))
                    and not any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in part)
                    for part in path.parts),
             "unsafe_job_output_path")
    return path.parts


def capture_relative(value, stage):
    """Extract an identity, never resolve or open the stored runner location."""
    require(isinstance(value, str) and bool(value) and stage in ("generator", "verifier")
            and not any(char in value for char in '<>"|?*'), "unsafe_call_capture_path")
    relative = value.replace("\\", "/")
    unc = relative.startswith("//")
    if re.match(r"[A-Za-z]:/", relative):
        relative = relative[3:]
    elif unc:
        relative = relative[2:]
    elif relative.startswith("/"):
        require("\\" not in value, "unsafe_call_capture_path")
        relative = relative[1:]
    try:
        parts = safe_relative(relative)
    except ValueError:
        raise ValueError("unsafe_call_capture_path") from None
    require(len(parts) >= (4 if unc else 2) and parts[-2] == "calls"
            and sum(part.casefold() == "calls" for part in parts) == 1
            and re.fullmatch(r"[0-9]{6,}_" + stage, parts[-1]), "unsafe_call_capture_path")
    return "/".join(parts[-2:])


def validate_selection(selection, selection_sha256, out_dir, *, materialize=False):
    """Validate all bindings before reserving an absent output directory.

    Only named files and selected job-pinned call captures are read. JSONL
    indexing detects ambiguity; unrelated call responses are not reparsed.
    """
    require(not os.path.lexists(out_dir), "absent_only_output_exists")
    out = absolute_path(os.fspath(out_dir))
    require(not os.path.lexists(out), "absent_only_output_exists")
    require(out.parent.is_dir(), "output_parent_must_exist")
    cache, json_cache, lines_cache = {}, {}, {}

    def read(ref):
        path = pin_shape(ref)
        if path in cache:
            require(cache[path][0] == ref["sha256"], "conflicting_path_pins")
            return cache[path][1]
        data = path.read_bytes()
        require(hashlib.sha256(data).hexdigest() == ref["sha256"], "artifact_hash_mismatch:" + str(path))
        cache[path] = (ref["sha256"], data)
        return data

    def obj(ref):
        data = read(ref)
        path = pin_shape(ref)
        if path not in json_cache:
            value = strict_json(data.decode("utf-8"))
            require(isinstance(value, dict), "json_object_required")
            json_cache[path] = value
        return json_cache[path]

    def lines(ref):
        data = read(ref)
        path = pin_shape(ref)
        if path not in lines_cache:
            rows = [(i, strict_json(line)) for i, line in
                    enumerate(data.decode("utf-8").splitlines(), 1) if line.strip()]
            require(all(isinstance(row, dict) for _, row in rows), "jsonl_object_required")
            lines_cache[path] = rows
        return lines_cache[path]

    def output_manifest(job, label, reasons):
        if type(job.get("acceptance_contract_version")) is not int or job["acceptance_contract_version"] != 2:
            reasons.append(label + "_acceptance_contract_v2_required")
        if job.get("output_file_hashes") is None:
            reasons.append(label + "_output_manifest_missing")
            return None
        hashes = job["output_file_hashes"]
        require(isinstance(hashes, dict), "invalid_job_output_manifest")
        for relative, digest in hashes.items():
            safe_relative(relative)
            require(relative not in ("job_record.json", "validation_report.json")
                    and isinstance(digest, str) and SHA.fullmatch(digest), "invalid_job_output_manifest")
        return hashes

    def job_output(root, relative, hashes):
        parts = safe_relative(relative)
        require(relative in hashes, "job_output_reference_missing:" + relative)
        path = root.joinpath(*parts)
        require(path.resolve() == path and not path.is_symlink(), "unsafe_job_output_symlink")
        ref = {"path": str(path), "sha256": hashes[relative]}
        read(ref)
        return ref

    def selected_call(meta, raw, model, prompt_sha, job_ref, hashes, stage, reasons):
        """Bind just this call's saved request/response/journal, never its peers."""
        prefix = "selected_" + stage
        if (not isinstance(meta, dict) or type(meta.get("http_status")) is not int
                or meta.get("http_status") != 200 or not isinstance(model, str) or not model.strip()
                or meta.get("model") != model or meta.get("finish_reason") != "stop"
                or "error" not in meta or meta["error"] is not None or meta.get("response_incomplete")):
            reasons.append(prefix + "_call_envelope_invalid")
        if not isinstance(meta, dict):
            return {}
        if not isinstance(raw, str) or meta.get("content_sha256") != C.sha256_text(raw):
            reasons.append(prefix + "_content_hash_missing_or_mismatch")
        capture = meta.get("capture_dir")
        if not isinstance(capture, str) or not capture.strip():
            reasons.append(prefix + "_capture_reference_missing")
            return {}
        root = Path(job_ref["path"]).parent
        capture = capture_relative(capture, stage)
        if hashes is None:
            return {}
        names = ("request_body.bin", "response_body.bin", "journal.jsonl")
        if any(capture + "/" + name not in hashes for name in names):
            reasons.append(prefix + "_capture_manifest_reference_missing")
            return {}
        captures = {name: job_output(root, capture + "/" + name, hashes) for name in names}
        try:
            request = obj(captures["request_body.bin"])
            response = obj(captures["response_body.bin"])
            journal = [row for _, row in lines(captures["journal.jsonl"])]
            messages = request.get("messages")
            require(request.get("model") == model and isinstance(messages, list) and bool(messages)
                    and isinstance(messages[-1], dict) and messages[-1].get("role") == "user"
                    and isinstance(messages[-1].get("content"), str)
                    and isinstance(prompt_sha, str) and SHA.fullmatch(prompt_sha)
                    and C.sha256_text(messages[-1]["content"]) == prompt_sha,
                    prefix + "_captured_request_mismatch")
            choices = response.get("choices")
            require(response.get("model") == model and isinstance(choices, list) and len(choices) == 1
                    and isinstance(choices[0], dict) and choices[0].get("finish_reason") == "stop"
                    and isinstance(choices[0].get("message"), dict)
                    and isinstance(raw, str) and choices[0]["message"].get("content") == raw,
                    prefix + "_captured_response_mismatch")
            require(len(journal) == 3 and [row.get("stage") for row in journal]
                    == ["request_saved", "response_saved", "envelope_validated"]
                    and journal[0].get("sha256") == captures["request_body.bin"]["sha256"]
                    and journal[1].get("sha256") == captures["response_body.bin"]["sha256"]
                    and type(journal[1].get("http_status")) is int and journal[1]["http_status"] == 200
                    and "error" in journal[2] and journal[2]["error"] is None,
                    prefix + "_capture_journal_invalid")
        except (ValueError, TypeError, KeyError, UnicodeError) as error:
            reasons.append(str(error) if str(error).startswith(prefix) else prefix + "_capture_invalid")
        return captures

    selection_ref = {"path": str(Path(selection).resolve()), "sha256": selection_sha256}
    manifest = obj(selection_ref)
    require(set(manifest) == {"schema_version", "entries"}
            and type(manifest["schema_version"]) is int and manifest["schema_version"] == 1,
            "unsupported_selection_schema")
    require(isinstance(manifest["entries"], list) and bool(manifest["entries"]), "explicit_entries_required")
    parser_ref = {"path": str(PARSER_PATH), "sha256": hashlib.sha256(PARSER_BYTES).hexdigest()}
    read(parser_ref)
    effective, seen, inventories, selected_ids = [], set(), {}, {}
    for entry in manifest["entries"]:
        require(isinstance(entry, dict) and set(entry) == ENTRY_KEYS, "bad_entry_shape")
        for key in ("work_id", "card_id"):
            require(isinstance(entry[key], str) and bool(entry[key].strip()), "invalid_" + key)
        require(entry["attempt_kind"] in ("original", "reverify"), "explicit_attempt_kind_required")
        require(isinstance(entry["candidate_sha256"], str) and SHA.fullmatch(entry["candidate_sha256"]),
                "invalid_candidate_sha256")
        refs = {key: {"path": str(pin_shape(entry[key])), "sha256": entry[key]["sha256"]}
                for key in ARTIFACTS}
        for ref in refs.values():
            read(ref)
        work, cid = entry["work_id"], entry["card_id"]
        # A snapshot/card cannot have competing choices, even via another path or candidate pin.
        identity = (work, refs["generator"]["sha256"], cid)
        require(identity not in seen, "duplicate_selection")
        seen.add(identity)
        job, vjob = obj(refs["generator_job"]), obj(refs["verifier_job"])
        reasons = []
        source_hashes = {"coverage_partition.jsonl": refs["coverage"]["sha256"],
                         "sentences.jsonl": refs["sentences"]["sha256"]}
        for bound_job in (job, vjob):
            require(bound_job.get("book") == work, "job_work_mismatch")
            hashes = bound_job.get("input_artifact_hashes")
            require(isinstance(hashes, dict) and all(hashes.get(k) == v for k, v in source_hashes.items()),
                    "job_source_hash_mismatch")
        require(Path(refs["generator"]["path"]).parent == Path(refs["generator_job"]["path"]).parent,
                "generator_job_not_sibling")
        require(Path(refs["verifier"]["path"]).parent == Path(refs["verifier_job"]["path"]).parent,
                "verifier_job_not_sibling")
        if entry["attempt_kind"] == "original":
            require(refs["generator_job"] == refs["verifier_job"]
                    and job.get("generator_reused", False) is False
                    and not str(job.get("execution_mode", "")).startswith("verifier_only"),
                    "original_not_sibling_generator")
        else:
            require(vjob.get("generator_reused") is True, "reverify_generator_not_reused")
            require(vjob.get("generator_jsonl_sha256") == refs["generator"]["sha256"],
                    "reverify_generator_hash_mismatch")
            # Old shipped jobs stored paths relative to the runner's BASE, not cwd.
            for key in ("generator_jsonl", "source_generator_jsonl"):
                if key not in vjob and key == "source_generator_jsonl":
                    continue
                value = vjob.get(key)
                require(isinstance(value, str) and bool(value.strip()), "reverify_generator_path_missing")
                bound_path = Path(value)
                if not bound_path.is_absolute():
                    bound_path = Path(C.BASE) / bound_path
                require(bound_path.resolve() == Path(refs["generator"]["path"]), "reverify_generator_path_mismatch")
            if "source_generator_jsonl_sha256" in vjob:
                require(vjob["source_generator_jsonl_sha256"] == refs["generator"]["sha256"],
                        "reverify_generator_hash_mismatch")
            require(vjob.get("source_book", work) == work, "reverify_source_work_mismatch")
            if "source_bindings" in vjob:
                require(vjob["source_bindings"] == source_hashes, "reverify_source_hash_mismatch")

        job_hashes = output_manifest(job, "generator_job", reasons)
        verifier_hashes = output_manifest(vjob, "verifier_job", reasons)
        for key, hashes in (("generator", job_hashes), ("verifier", verifier_hashes)):
            if hashes is not None:
                path = Path(refs[key]["path"])
                require(hashes.get(path.name) == refs[key]["sha256"], "job_output_hash_mismatch:" + key)
                job_output(Path(refs[key + "_job"]["path"]).parent, path.name, hashes)

        inventory_key = (work, refs["generator"]["path"], refs["generator"]["sha256"])
        if inventory_key not in inventories:
            gen_rows = indexed(lines(refs["generator"]), "window_id")
            cards = []
            for _, grow in gen_rows.values():
                require(grow.get("work_id", work) == work and grow.get("allowed_work_ids") == [work],
                        "generator_row_work_mismatch")
                require(isinstance(grow.get("cards"), list), "generator_cards_not_list")
                for item in grow["cards"]:
                    require(isinstance(item, dict), "generator_card_not_object")
                    cards.append((grow, item))
            by_card = indexed(cards, "card_id")
            inventories[inventory_key] = (refs["generator"], by_card)
            selected_ids[inventory_key] = set()
        by_card = inventories[inventory_key][1]
        require(cid in by_card, "selected_generator_card_missing")
        grow, item = by_card[cid]
        coverage = indexed(lines(refs["coverage"]), "window_id")
        sources = indexed(lines(refs["sentences"]), "sentence_id")
        for _, source in list(coverage.values()) + list(sources.values()):
            require(source.get("work_id") in (None, work), "source_work_mismatch")
        wid = grow["window_id"]
        require(wid in coverage, "coverage_window_missing")
        window = C.build_window({**coverage[wid][1], "work_id": work},
                                {sid: row for sid, (_, row) in sources.items()})
        require(grow.get("chapter_id") == window["chapter_id"]
                and grow.get("sentence_ids") == window["sentence_ids"], "generator_row_source_binding_mismatch")

        def card_binding(row):
            require(row.get("work_id") == work and row.get("allowed_work_ids") == [work],
                    "card_work_mismatch")
            require(row.get("window_id") == wid and row.get("chapter_id") == window["chapter_id"],
                    "card_window_binding_mismatch")

        card_binding(item)
        normalized, errors = C.validate_card(item.get("normalized_card"), window)
        original, original_errors = C.validate_card(item.get("generator_card"), window)
        require(not errors and not original_errors and normalized == original == item.get("normalized_card")
                and item.get("accepted_for_verification") is True
                and item.get("route") == normalized["primary_route"], "invalid_normalized_generator_card")
        require(candidate_sha256(normalized) == entry["candidate_sha256"], "candidate_hash_mismatch")
        evidence = C.render_evidence(normalized, window)
        generator_captures = selected_call(grow.get("call_meta"), grow.get("raw_response"), job.get("model"),
                                          grow.get("prompt_sha256"), refs["generator_job"], job_hashes,
                                          "generator", reasons)
        if grow.get("model_parse_ok") is not True or "parse_error" not in grow or grow["parse_error"] is not None:
            reasons.append("selected_generator_parse_status_invalid")
        try:
            payload, parse_error = C.parse_strict(grow.get("raw_response"))
        except RecursionError:
            payload, parse_error = None, "json_nesting_too_deep"
        proposed = payload.get("propositions") if payload is not None else None
        if (parse_error or payload is None or set(payload) != {"propositions"}
                or not isinstance(proposed, list) or len(proposed) > C.MAX_CARDS_PER_WINDOW):
            reasons.append("selected_generator_raw_propositions_invalid")
        elif (type(grow.get("proposed_count")) is not int or grow["proposed_count"] != len(proposed)
              or len(grow["cards"]) != len(proposed)
              or any(row.get("card_id") != f"{wid}#{i}"
                     or canonical_bytes(row.get("generator_card")) != canonical_bytes(proposed[i])
                     for i, row in enumerate(grow["cards"]))):
            reasons.append("selected_generator_card_correspondence_invalid")
        verifier_rows = indexed(lines(refs["verifier"]), "card_id")
        checks, cited, overall, line_number, verifier_captures = [], [], None, None, {}
        if cid not in verifier_rows:
            reasons.append("selected_verifier_row_missing")
        else:
            line_number, chosen = verifier_rows[cid]
            card_binding(chosen)
            for key in ("normalized_card", "generator_card"):
                if chosen.get(key) is None:
                    reasons.append("selected_verifier_" + key + "_missing")
                else:
                    require(canonical_bytes(chosen[key]) == canonical_bytes(item[key]),
                            "verifier_candidate_mismatch")
            if chosen.get("accepted_for_verification") is not True or chosen.get("route") != item["route"]:
                reasons.append("selected_verifier_card_unusable")
            verifier = chosen.get("verifier")
            if not isinstance(verifier, dict) or not isinstance(verifier.get("call_meta"), dict):
                reasons.append("selected_verifier_payload_missing")
            else:
                meta = {**verifier["call_meta"], "content": verifier.get("raw_response")}
                verifier_captures = selected_call(verifier["call_meta"], verifier.get("raw_response"),
                                                 vjob.get("verifier_model"), verifier.get("prompt_sha256"),
                                                 refs["verifier_job"], verifier_hashes, "verifier", reasons)
                if not isinstance(vjob.get("verifier_model"), str) or not vjob["verifier_model"].strip():
                    reasons.append("verifier_job_model_required")
                try:
                    _, overall, checks, cited, parse_errors = C.parse_verifier_card(
                        meta, f"{work}|{wid}|{cid}", window, normalized, vjob.get("verifier_model"))
                    reasons.extend(parse_errors)
                except RecursionError:
                    reasons.append("verifier_json_nesting_too_deep")
                if verifier.get("errors"):
                    reasons.append("selected_verifier_recorded_errors")
                if ("content_sha256" in meta and (not isinstance(meta["content"], str)
                        or meta["content_sha256"] != C.sha256_text(meta["content"]))):
                    reasons.append("selected_verifier_content_hash_mismatch")
            if type(vjob.get("acceptance_contract_version")) is not int or vjob["acceptance_contract_version"] != 2:
                reasons.append("explicit_acceptance_contract_v2_required")
        status = "unverified" if reasons else overall
        selected_ids[inventory_key].add(cid)
        effective.append({"schema_version": 1, "work_id": work, "card_id": cid,
                          "window_id": wid, "chapter_id": window["chapter_id"],
                          "attempt_kind": entry["attempt_kind"], **refs,
                          "candidate_sha256": entry["candidate_sha256"], "selection": selection_ref,
                          "strict_parser": parser_ref, "verifier_line": line_number,
                          "selected_call_captures": {"generator": generator_captures, "verifier": verifier_captures},
                          "effective_status": status, "contract_overall": overall,
                          "reasons": sorted(set(reasons)), "checks": checks, "cited_evidence_ids": cited,
                          "route": normalized["primary_route"], "normalized_card": normalized,
                          "evidence_block": evidence, "evidence_sha256": C.sha256_text(evidence),
                          "publication_status": "candidate_not_confirmed", "transfer_policy": "no_transfer",
                          "review_status": "REVIEW", "allowed_work_ids": [work], **BOUNDARIES})
    unselected = []
    for key, (ref, cards) in inventories.items():
        for cid in sorted(set(cards) - selected_ids[key]):
            unselected.append({"work_id": key[0], "generator": ref, "card_id": cid,
                               "effective_status": "not_selected", "implied_accepted": False})
    report = {"schema_version": 1, "selection": selection_ref, "strict_parser": parser_ref,
              "dry_run": not materialize, "selected_cards": len(effective),
              "effective_status_counts": dict(sorted(Counter(row["effective_status"] for row in effective).items())),
              "entailed_review_queue_counts": {route: sum(row["effective_status"] == "entailed"
                  and row["route"] == route for row in effective) for route in C.PRIMARY_ROUTES},
              "unselected_cards": unselected, "unselected_implied_accepted": False,
              "inventory_scope": "Only explicitly pinned generator snapshots; all other cards outside scope.",
              "output_validation_scope": "Selected JSONL files and selected call captures; not the full attempt tree.",
              **BOUNDARIES}
    # Recheck pinned inputs before any write; never reuse a changed cached file.
    for path, (pin, _) in cache.items():
        require(C.sha256_file(str(path)) == pin, "artifact_changed_during_validation")
    if materialize:
        out.mkdir(exist_ok=False)
        with (out / "effective_manifest.jsonl").open("xb") as handle:
            handle.write(b"".join(canonical_bytes(row) + b"\n" for row in effective))
        queues = out / "entailed_REVIEW_queues"
        queues.mkdir()
        for route in C.PRIMARY_ROUTES:
            with (queues / (route + ".jsonl")).open("xb") as handle:
                handle.write(b"".join(canonical_bytes(row) + b"\n" for row in effective
                                      if row["effective_status"] == "entailed" and row["route"] == route))
        with (out / "reconciliation_report.json").open("xb") as handle:
            handle.write(canonical_bytes(report) + b"\n")
    return effective, report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selection", required=True)
    parser.add_argument("--selection-sha256", required=True)
    parser.add_argument("--out-dir", required=True, help="absolute absent path with existing parent")
    parser.add_argument("--materialize", action="store_true", help="write a new review-only view")
    args = parser.parse_args(argv)
    try:
        _, report = validate_selection(args.selection, args.selection_sha256, args.out_dir,
                                       materialize=args.materialize)
    except (ValueError, OSError, TypeError, KeyError, UnicodeError, RecursionError) as error:
        print("FAIL: " + ("json_nesting_too_deep" if isinstance(error, RecursionError) else str(error)),
              file=sys.stderr)
        return 2
    print(json.dumps(report, ensure_ascii=True, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
