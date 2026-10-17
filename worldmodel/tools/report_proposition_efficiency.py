"""Offline diagnostics from an explicit, externally pinned snapshot inventory.

No runner imports, discovery, capture-path following, or semantic/raw-response parsing.
See runs/_extraction_scheduler/20260924/production_round1_audit_20261015/INFERENCE_EFFICIENCY_REPORT.md.
"""

import argparse
from collections import Counter
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import stat
import sys


SHA = re.compile(r"[0-9a-f]{64}")
ROUTES = frozenset(("mechanism", "bounded_event", "entity_profile", "relationship_institution",
                    "environment_location", "attributed_context", "tactic_context", "source_noise_fragment"))
FIELDS = frozenset(("primary_route", "proposition_text", "assertion_status", "temporal_status",
                    "evidence_directness", "content_facets", "generality_scope", "claimant_or_source",
                    "evidence_ids", "evidence_spans"))
OVERALL = frozenset(("entailed", "insufficient", "insufficient_evidence", "contradicted", "abstain"))
TOKENS = ("prompt_tokens", "completion_tokens", "total_tokens")
COUNTS = ("proposer_cards", "cards_considered", "cards_verified", "cards_valid", "cards_unusable",
          "cards_schema_or_span_rejected", "generator_attempts", "verifier_attempts", "total_calls")
PENDING = frozenset(("running", "pending", "not_started", "incomplete"))
TERMINAL = frozenset(("completed", "failed", "no_eligible_windows"))
PROFILES = frozenset(("structured_source", "structured_render", "unstructured_analysis"))
MODES = PROFILES | frozenset(("verifier_only_reverify_8001", "degraded_generation_unstructured_analysis",
                             "degraded_generation_structured_render"))
FINISHES = frozenset(("stop", "length", "content_filter", "tool_calls", "function_call"))
# proposition_verifier_prompt_v1.txt; v2/v3 checks contain free reasons, not codes.
REASONS = frozenset(("source_supported", "not_established", "material_expansion", "modality_conflict",
                     "temporal_conflict", "attribution_conflict", "unusable_source"))
# Closed diagnostic names emitted by proposition_canary_run.py's card/verifier contracts.
ERRORS = frozenset((
    "missing_key", "unknown_key", "card_not_object", "bad_primary_route", "bad_assertion_status",
    "bad_temporal_status", "bad_evidence_directness", "bad_generality_scope", "empty_proposition_text",
    "bad_claimant_or_source", "bad_content_facets", "duplicate_content_facets", "bad_evidence_ids",
    "duplicate_evidence_ids", "no_evidence_spans", "bad_evidence_span_shape", "span_sentence_not_in_window",
    "span_offsets_not_int", "span_out_of_bounds", "duplicate_evidence_span", "evidence_ids_span_mismatch",
    "empty_response", "invalid_json", "not_an_object", "verdict_block_duplicate", "verdict_block_absent",
    "verdict_block_trailing", "verdict_block_malformed", "verdict_block_not_object", "verifier_call_failed",
    "verifier_finish_not_stop", "verifier_model_mismatch", "normalized_card_required", "bad_verifier_shape",
    "bad_overall", "case_id_mismatch", "no_runtime_effect_missing", "checks_required", "bad_check_shape",
    "bad_field_path", "duplicate_field_path", "bad_check_verdict", "bad_check_reason", "check_citations_required",
    "duplicate_check_citation", "cited_outside_sent_card_evidence", "unresolved_claimant_requires_insufficient",
    "required_field_coverage", "overall_check_mismatch", "response_model_mismatch", "response_choices_not_one",
    "response_finish_not_stop", "response_content_not_string", "TimeoutError", "URLError", "HTTPError",
    "ConnectionError", "ConnectionResetError", "IncompleteRead", "UnicodeDecodeError", "ValueError",
))


def require(condition, code):
    if not condition:
        raise ValueError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=True, allow_nan=False, indent=2) + "\n").encode("utf-8")


def strict_json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate_json_key")
            result[key] = value
        return result

    def nonfinite(_):
        raise ValueError("nonfinite_json")

    def finite_float(text):
        value = float(text)
        require(math.isfinite(value), "nonfinite_json")
        return value

    try:
        return json.loads(data, object_pairs_hook=unique, parse_constant=nonfinite, parse_float=finite_float)
    except (RecursionError, UnicodeError, json.JSONDecodeError):
        raise ValueError("invalid_json") from None


def safe_path(value):
    require(isinstance(value, (str, Path)), "invalid_path")
    text = str(value)
    require(text and not text.startswith(("\\\\", "//"))
            and not any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in text), "unsafe_path")
    path = Path(text)
    require(path.is_absolute() and not any(p in (".", "..") for p in text.replace("\\", "/").split("/")),
            "absolute_nontraversing_path_required")
    for part in path.parts[1:]:
        require(not part.endswith((".", " ")) and not any(c in part for c in '<>:"|?*')
                and not re.fullmatch(r"(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part), "unsafe_path")
    for node in (path, *path.parents):
        if os.path.lexists(node):
            info = node.lstat()
            require(not stat.S_ISLNK(info.st_mode)
                    and not getattr(info, "st_file_attributes", 0) & 0x400, "unsafe_path_link")
    return path


def identity(value):
    require(isinstance(value, str) and 0 < len(value) <= 240 and value == value.strip()
            and not any(c.isspace() or ord(c) < 32 or 127 <= ord(c) <= 159 or c in '/\\|<>"' for c in value),
            "invalid_id")
    return value


def nonnegative(value):
    return type(value) is int and value >= 0


def label(value):
    # Metadata labels are never a channel for arbitrary prose.
    return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:/-]{1,120}", value) else "unknown"


def enum(value, vocabulary):
    return value if isinstance(value, str) and value in vocabulary else "unknown"


def code(value, vocabulary=ERRORS):
    if not isinstance(value, str):
        return "unknown_code"
    # Error suffixes may contain field names/source; reason codes require exact equality.
    prefix = value.split(":", 1)[0] if vocabulary is ERRORS else value
    if vocabulary is ERRORS and re.fullmatch(r"http_[1-5][0-9]{2}", prefix):
        return "http_error"
    return prefix if prefix in vocabulary else "unknown_code"


def codes(value, vocabulary=ERRORS):
    return [code(v, vocabulary) for v in value] if isinstance(value, list) else []


def capture_origin(meta, job_ref, stage):
    """Lexical claimed origin only. Never stat/resolve/open an unpinned capture path."""
    value = meta.get("capture_dir")
    if value is None:
        return None
    if not isinstance(value, str) or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in value):
        return ""
    text = value.replace("\\", "/")
    windows = bool(re.match(r"^[A-Za-z]:/", text))
    if windows or (os.name == "nt" and not text.startswith("/")):
        text = text.casefold()
    absolute = windows or text.startswith("/")
    parts = text.split("/")
    if (text.startswith("//") or any(p in (".", "..") or p.endswith((".", " ")) for p in parts)
            or any(not p for p in parts[1:])
            or not re.fullmatch(r"[0-9]{6}_" + stage, parts[-1])
            or len(parts) < 2 or parts[-2] != "calls"):
        return ""
    components = parts[1:] if absolute else parts
    if any(any(c in p for c in '<>:"|?*') or re.fullmatch(r"(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", p)
           for p in components):
        return ""
    if not absolute and (len(parts) != 2 or ":" in text):
        return ""
    if absolute:
        origin = PureWindowsPath(text).as_posix().casefold() if windows else PurePosixPath(text).as_posix()
    else:
        origin = (Path(job_ref["path"]).parent / text).as_posix()
        if os.name == "nt":
            origin = origin.casefold()
    return digest(origin.encode("utf-8"))


class Inputs:
    def __init__(self):
        self.pins = {}
        self.files = {}

    def register(self, ref):
        require(isinstance(ref, dict) and set(ref) == {"path", "sha256"}, "bad_reference")
        require(isinstance(ref["path"], str) and isinstance(ref["sha256"], str)
                and SHA.fullmatch(ref["sha256"]), "bad_reference")
        path = safe_path(ref["path"])
        require(path not in self.pins or self.pins[path] == ref["sha256"], "conflicting_pins")
        self.pins[path] = ref["sha256"]
        return path

    def read(self, ref):
        path = self.register(ref)
        if path not in self.files:
            require(path.is_file(), "input_file_required")
            before = path.stat()
            data = path.read_bytes()
            require(before == path.stat() and digest(data) == self.pins[path], "input_hash_mismatch")
            self.files[path] = (data, before)
        return self.files[path][0]

    def obj(self, ref):
        value = strict_json(self.read(ref))
        require(isinstance(value, dict), "object_required")
        return value

    def rows(self, ref):
        result = []
        # splitlines() would incorrectly split literal Unicode separators in JSON strings.
        for line, data in enumerate(self.read(ref).split(b"\n"), 1):
            if data.strip():
                row = strict_json(data)
                require(isinstance(row, dict), "row_object_required")
                result.append((line, row))
        return result

    def recheck(self):
        for path, (_, before) in self.files.items():
            require(safe_path(path).is_file(), "input_changed")
            data = path.read_bytes()
            require(path.stat() == before and digest(data) == self.pins[path], "input_changed")


def summarize_calls(calls):
    result = {"call_metadata_rows": len(calls), "known_usage": {}, "usage_field_calls": {},
              "calls_missing_usage": 0, "calls_partial_usage": 0, "calls_complete_usage": 0,
              "calls_missing_or_partial_usage": 0, "token_accounting_flags": {},
              "finish_counts": {}, "response_models": {}, "expected_models": {},
              "model_identity_mismatches": 0, "model_identity_unavailable": 0,
              "error_calls": 0, "error_groups": {}, "explicit_reasoning_tokens": None,
              "calls_with_explicit_reasoning_tokens": 0,
              "calls_missing_capture_identity": 0, "calls_invalid_capture_identity": 0,
              "calls_with_capture_identity": 0, "distinct_claimed_capture_origins": 0,
              "rows_with_suspected_duplicate_origin": 0,
              "calls_missing_attempts": 0, "calls_invalid_attempts": 0, "calls_zero_attempts": 0,
              "calls_with_explicit_attempts": 0, "known_call_attempts_sum": None,
              "known_prior_retry_attempts": None, "calls_with_explicit_retries": 0,
              "prior_retry_tokens": None, "prior_retry_tokens_unknown": True}
    flags, finishes, models, expected_models, errors = (Counter() for _ in range(5))
    sums, present = Counter(), Counter()
    reasoning, attempts_sum, retry_sum = 0, 0, 0
    origins = Counter()
    for meta, expected, origin in calls:
        if origin is None:
            result["calls_missing_capture_identity"] += 1
        elif not origin:
            result["calls_invalid_capture_identity"] += 1
        else:
            result["calls_with_capture_identity"] += 1
            origins[origin] += 1
        attempts = meta.get("attempts")
        if "attempts" not in meta:
            result["calls_missing_attempts"] += 1
        elif not nonnegative(attempts):
            result["calls_invalid_attempts"] += 1
        else:
            result["calls_with_explicit_attempts"] += 1
            result["calls_zero_attempts"] += attempts == 0
            result["calls_with_explicit_retries"] += attempts > 1
            attempts_sum += attempts
            retry_sum += max(0, attempts - 1)
        usage = meta.get("usage")
        usage = usage if isinstance(usage, dict) else {}
        known = {k: usage[k] for k in TOKENS if nonnegative(usage.get(k))}
        for key in TOKENS:
            if key in usage and not nonnegative(usage[key]):
                flags["invalid_" + key] += 1
        for key, value in known.items():
            sums[key] += value
            present[key] += 1
        bucket = "complete" if len(known) == 3 else "partial" if known else "missing"
        result["calls_" + bucket + "_usage"] += 1
        if len(known) == 3 and known["prompt_tokens"] + known["completion_tokens"] != known["total_tokens"]:
            flags["prompt_plus_completion_ne_total"] += 1
        details = usage.get("completion_tokens_details")
        if isinstance(details, dict) and "reasoning_tokens" in details:
            if nonnegative(details["reasoning_tokens"]):
                value = details["reasoning_tokens"]
                reasoning += value
                result["calls_with_explicit_reasoning_tokens"] += 1
                if "completion_tokens" in known and value > known["completion_tokens"]:
                    flags["reasoning_gt_completion"] += 1
            else:
                flags["invalid_reasoning_tokens"] += 1
        finishes[enum(meta.get("finish_reason"), FINISHES)] += 1
        models[label(meta.get("model"))] += 1
        expected_models[label(expected)] += 1
        if label(expected) == "unknown" or label(meta.get("model")) == "unknown":
            result["model_identity_unavailable"] += 1
        elif expected != meta["model"]:
            result["model_identity_mismatches"] += 1
        call_errors = []
        if meta.get("error") is not None:
            call_errors.append(code(meta["error"]))
        if "http_status" in meta and (type(meta["http_status"]) is not int or meta["http_status"] != 200):
            call_errors.append("http_non_200_or_invalid")
        if meta.get("response_incomplete") is True:
            call_errors.append("response_incomplete")
        if call_errors:
            result["error_calls"] += 1
            errors.update(set(call_errors))
    result["known_usage"] = {k: sums[k] if present[k] else None for k in TOKENS}
    result["usage_field_calls"] = {k: present[k] for k in TOKENS}
    result["calls_missing_or_partial_usage"] = result["calls_missing_usage"] + result["calls_partial_usage"]
    result["missing_or_partial_usage_rate"] = result["calls_missing_or_partial_usage"] / len(calls) if calls else None
    if result["calls_with_explicit_reasoning_tokens"]:
        result["explicit_reasoning_tokens"] = reasoning
    if result["calls_with_explicit_attempts"]:
        result["known_call_attempts_sum"] = attempts_sum
        result["known_prior_retry_attempts"] = retry_sum
    result["prior_retry_tokens_unknown"] = bool(result["calls_missing_attempts"] or result["calls_invalid_attempts"]
                                                or result["calls_zero_attempts"] or retry_sum)
    if not result["prior_retry_tokens_unknown"]:
        result["prior_retry_tokens"] = 0
    result["distinct_claimed_capture_origins"] = len(origins)
    result["rows_with_suspected_duplicate_origin"] = sum(n for n in origins.values() if n > 1)
    for key, counter in (("token_accounting_flags", flags), ("finish_counts", finishes),
                         ("response_models", models), ("expected_models", expected_models), ("error_groups", errors)):
        result[key] = dict(sorted(counter.items()))
    return result


def diagnose_attempt(entry, job, validation, store):
    work = entry["work_id"]
    for obj in (job, validation):
        for key in ("book", "work_id"):
            if key in obj:
                require(obj[key] == work, "work_mismatch")
    js, vs = job.get("status"), validation.get("status")
    require(js is None or js in PENDING | TERMINAL, "invalid_job_status")
    require(vs is None or vs in PENDING | TERMINAL, "invalid_validation_status")
    if js is not None and vs is not None:
        require(js == vs, "contradictory_status")
    for obj in (job, validation):
        if "status" in obj and "ok" in obj:
            require(type(obj["ok"]) is bool and (obj["status"] not in TERMINAL
                    or obj["ok"] == (obj["status"] != "failed")), "contradictory_ok_status")
    version = job.get("acceptance_contract_version")
    if version == 2 or validation.get("acceptance_contract_version") == 2:
        require(type(version) is int and version == 2
                and type(validation.get("acceptance_contract_version")) is int
                and validation["acceptance_contract_version"] == 2 and js is not None and vs is not None,
                "v2_metadata_incomplete")
    pending = js in PENDING or vs in PENDING
    result = {k: entry[k] for k in ("work_id", "attempt_id", "attempt_kind")}
    result.update(state="pending" if pending else "observed_terminal" if js in TERMINAL or vs in TERMINAL else "legacy_unvalidated",
                  refs={k: entry[k] for k in ("job", "validation", "generator", "verifier") if k in entry},
                  execution_mode=enum(job.get("execution_mode"), MODES), stages=[], cardinality=None,
                  verifier_diagnostics=None, accepted_card_token_cost=None,
                  accepted_card_token_cost_scope="attempt-row final-response tokens per lineage-joined recorded entailed card; not unique provider compute, currency or quality")
    if pending:
        result["deferred_result_refs"] = [k for k in ("generator", "verifier") if k in entry]
        return result, []
    reported = {k: validation[k] for k in COUNTS if nonnegative(validation.get(k))}
    result["reported_counts"] = reported
    result["missing_or_invalid_reported_counts"] = [k for k in COUNTS if k not in reported]
    emitted, eligible, submitted, rejected, rejected_groups = {}, {}, {}, {}, Counter()
    verifier_cards, valid, unusable, unclassified = {}, set(), set(), set()
    overall_valid, overall_errors, check_counts, reason_counts, causes, verifier_errors = (Counter() for _ in range(6))
    accepted = set()
    all_calls = []
    locators, capture_ids = [], set()
    bindings, joined, join_unknown = {}, set(), set()
    for stage in ("generator", "verifier"):
        profile = enum(job.get(stage + "_profile"), PROFILES)
        stage_result = {"stage": stage, "execution_mode": result["execution_mode"], "profile": profile,
                        "reported_attempts": reported.get(stage + "_attempts"), "observed_rows": None}
        calls = []
        reused = stage == "generator" and (entry["attempt_kind"] == "reverify" or job.get("generator_reused") is True)
        stage_result["availability"] = "reused_not_compute" if reused else "available" if stage in entry else "not_explicitly_declared"
        if stage not in entry:
            stage_result.update(summarize_calls([]))
            stage_result["reported_minus_call_rows"] = None
            stage_result["reported_minus_call_attempts"] = None
            result["stages"].append(stage_result)
            continue
        rows = store.rows(entry[stage])
        stage_result["observed_rows"] = len(rows)
        seen = set()
        for line, row in rows:
            require(row.get("work_id", work) == work, "work_mismatch")
            rid = identity(row.get("window_id" if stage == "generator" else "card_id"))
            require(rid not in seen, "duplicate_row_id")
            seen.add(rid)
            owner = row if stage == "generator" else row.get("verifier")
            if not isinstance(owner, dict):
                owner = {}
            meta = None if reused else owner.get("call_meta")
            if isinstance(meta, dict):
                origin = capture_origin(meta, entry["job"], stage)
                if origin:
                    require(origin not in capture_ids, "duplicate_capture_id")
                    capture_ids.add(origin)
                calls.append((meta, job.get("model" if stage == "generator" else "verifier_model"), origin))
            locators.append({"stage": stage, "line": line, "id": rid, "has_call_meta": isinstance(meta, dict)})
            if stage == "generator":
                cards = row.get("cards")
                require(isinstance(cards, list), "cards_list_required")
                for card in cards:
                    require(isinstance(card, dict), "card_object_required")
                    cid = identity(card.get("card_id"))
                    require(cid not in emitted, "duplicate_card_id")
                    require(card.get("work_id", work) == work and card.get("window_id", rid) == rid, "card_binding_mismatch")
                    route = card.get("route")
                    route = route if isinstance(route, str) and route in ROUTES else "unknown"
                    emitted[cid] = route
                    bindings[cid] = (rid, card.get("route"), row.get("work_id") == work and card.get("work_id") == work
                                     and card.get("window_id") == rid and route != "unknown")
                    if card.get("accepted_for_verification") is True:
                        eligible[cid] = route
                    elif card.get("accepted_for_verification") is False:
                        rejected[cid] = route
                        rejected_groups.update(set(codes(card.get("schema_errors"))) or {"unclassified_rejection"})
            else:
                wid = identity(row.get("window_id"))
                route = row.get("route")
                if "generator" in entry:
                    require(rid in eligible, "verifier_card_not_generator_eligible")
                    bound_window, bound_route, complete = bindings[rid]
                    require(wid == bound_window and route == bound_route, "verifier_lineage_mismatch")
                    if complete and row.get("work_id") == work:
                        joined.add(rid)
                    else:
                        join_unknown.add(rid)
                else:
                    join_unknown.add(rid)
                route = route if isinstance(route, str) and route in ROUTES else "unknown"
                verifier_cards[rid] = route
                if isinstance(meta, dict):
                    submitted[rid] = route
                errors = owner.get("errors")
                recorded_valid = isinstance(errors, list) and not errors and owner.get("verdict") in OVERALL
                recorded_error = isinstance(errors, list) and bool(errors)
                if recorded_valid:
                    valid.add(rid)
                elif recorded_error:
                    unusable.add(rid)
                    verifier_errors.update(set(codes(errors)))
                else:
                    unclassified.add(rid)
                target = overall_valid if recorded_valid else overall_errors
                ov = owner.get("contract_overall", owner.get("verdict"))
                ov = ov if isinstance(ov, str) and ov in OVERALL else "unknown"
                target[ov] += 1
                reason_counts.update(codes(owner.get("reason_codes"), REASONS))
                checks = owner.get("checks")
                if isinstance(checks, list):
                    for check in checks:
                        if not isinstance(check, dict):
                            continue
                        field = check.get("field_path")
                        field = field if isinstance(field, str) and field in FIELDS else "unknown_field"
                        verdict = check.get("verdict")
                        verdict = verdict if isinstance(verdict, str) and verdict in OVERALL else "unknown"
                        check_counts[("recorded_valid" if recorded_valid else "error_or_unclassified", field, verdict)] += 1
                        reason_counts.update(codes(check.get("reason_codes"), REASONS))
                        if "reason_code" in check:
                            reason_counts[code(check["reason_code"], REASONS)] += 1
                if recorded_valid and ov in ("insufficient", "insufficient_evidence", "abstain"):
                    explicit = set(codes(owner.get("reason_codes"), REASONS)) - {"unknown_code"}
                    if isinstance(checks, list):
                        for check in checks:
                            if isinstance(check, dict) and check.get("verdict") in ("insufficient", "insufficient_evidence", "abstain"):
                                explicit.update(codes(check.get("reason_codes"), REASONS))
                                if "reason_code" in check:
                                    explicit.add(code(check["reason_code"], REASONS))
                    explicit.discard("unknown_code")
                    causes.update(explicit or {"cause_unclassified_requires_review"})
                if recorded_valid and ov == "entailed" and owner.get("verdict") == "entailed":
                    accepted.add(rid)
        stage_result.update(summarize_calls(calls))
        stage_result["rows_without_call_meta"] = len(rows) - len(calls) if not reused else None
        count = stage_result["reported_attempts"]
        stage_result["reported_minus_call_rows"] = count - len(calls) if count is not None else None
        stage_result["reported_minus_call_attempts"] = count - stage_result["known_call_attempts_sum"] if (
            count is not None and stage_result["known_call_attempts_sum"] is not None
            and not stage_result["calls_missing_attempts"] and not stage_result["calls_invalid_attempts"]) else None
        result["stages"].append(stage_result)
        all_calls.extend((stage, result["execution_mode"], profile, meta, expected, origin) for meta, expected, origin in calls)
    gen_available = "generator" in entry
    observed = {"emitted": len(emitted) if gen_available else None,
                "eligible_for_verification": len(eligible) if gen_available else None,
                "submitted_for_verification": len(submitted) if "verifier" in entry else None,
                "schema_rejected": len(rejected) if gen_available else None,
                "verifier_result_rows": len(verifier_cards) if "verifier" in entry else None,
                "valid": len(valid) if "verifier" in entry else None,
                "unusable": len(unusable) if "verifier" in entry else None,
                "validity_unclassified": len(unclassified) if "verifier" in entry else None,
                "recorded_entailed": len(accepted) if "verifier" in entry else None}
    comparisons = {"emitted": "proposer_cards", "eligible_for_verification": "cards_considered",
                   "submitted_for_verification": "verifier_attempts",
                   "schema_rejected": "cards_schema_or_span_rejected", "verifier_result_rows": "cards_verified",
                   "valid": "cards_valid", "unusable": "cards_unusable"}
    result["cardinality"] = {"observed": observed, "reported_expected": reported,
                              "generator_cards_scope": "reused_input" if result["stages"][0]["availability"] == "reused_not_compute" else "attempt_generator_rows",
                              "reported_counts_complete": not result["missing_or_invalid_reported_counts"],
                             "observed_minus_reported": {k: observed[k] - reported[v] if observed[k] is not None and v in reported else None
                                                         for k, v in comparisons.items()},
                              "rejected_reason_groups": dict(sorted(rejected_groups.items())),
                              "per_route": [{"route": route,
                                             "emitted": sum(v == route for v in emitted.values()) if gen_available else None,
                                             "eligible_for_verification": sum(v == route for v in eligible.values()) if gen_available else None,
                                             "submitted_for_verification": sum(v == route for v in submitted.values()) if "verifier" in entry else None,
                                             "verifier_rows": sum(v == route for v in verifier_cards.values()) if "verifier" in entry else None,
                                             "valid": sum(verifier_cards[c] == route for c in valid) if "verifier" in entry else None,
                                             "unusable": sum(verifier_cards[c] == route for c in unusable) if "verifier" in entry else None}
                                           for route in sorted(set(emitted.values()) | set(verifier_cards.values()))]}
    result["verifier_diagnostics"] = {"availability": "available" if "verifier" in entry else "not_explicitly_declared",
        "overall_recorded_valid": dict(sorted(overall_valid.items())), "overall_error_or_unclassified": dict(sorted(overall_errors.items())),
        "structured_checks": [{"validity": bucket, "field": f, "verdict": v, "count": n}
                              for (bucket, f, v), n in sorted(check_counts.items())],
        "verifier_error_groups": dict(sorted(verifier_errors.items())),
        "structured_reason_codes": dict(sorted(reason_counts.items())), "insufficient_causes": dict(sorted(causes.items()))}
    result["row_locators"] = locators
    result["lineage"] = {"status": "joined" if gen_available and not join_unknown else "unknown",
                         "joined_verifier_rows": len(joined), "unknown_verifier_rows": len(join_unknown)}
    total = summarize_calls([(m, e, o) for _, _, _, m, e, o in all_calls])
    result["reported_total_minus_call_rows"] = reported["total_calls"] - len(all_calls) if "total_calls" in reported else None
    attempts_complete = not (total["calls_missing_attempts"] or total["calls_invalid_attempts"] or total["calls_zero_attempts"]
                             or any(s.get("rows_without_call_meta") for s in result["stages"]))
    retry_accounting = {"job_retried_calls": job["retried_calls"] if nonnegative(job.get("retried_calls")) else None,
                        "job_total_calls": job["total_calls"] if nonnegative(job.get("total_calls")) else None,
                        "missing_or_invalid_job_counts": [k for k in ("retried_calls", "total_calls") if not nonnegative(job.get(k))],
                        "call_attempt_knowledge_complete": attempts_complete,
                        "observed": total, "conflicts": []}
    for field, actual in (("retried_calls", total["calls_with_explicit_retries"]), ("total_calls", len(all_calls))):
        if retry_accounting["job_" + field] is not None and attempts_complete and retry_accounting["job_" + field] != actual:
            retry_accounting["conflicts"].append("job_" + field + "_mismatch")
    if attempts_complete and total["known_call_attempts_sum"] is not None and "total_calls" in reported:
        retry_accounting["validation_minus_call_attempts"] = reported["total_calls"] - total["known_call_attempts_sum"]
        if retry_accounting["validation_minus_call_attempts"]:
            retry_accounting["conflicts"].append("validation_total_vs_call_attempts_mismatch")
    if result["reported_total_minus_call_rows"] not in (None, 0):
        retry_accounting["conflicts"].append("validation_total_vs_call_rows_mismatch")
    for s in result["stages"]:
        if s["reported_minus_call_rows"] not in (None, 0) or s["reported_minus_call_attempts"] not in (None, 0):
            retry_accounting["conflicts"].append(s["stage"] + "_validation_attempts_mismatch")
    retry_accounting["prior_retry_tokens_unknown"] = bool(
        total["prior_retry_tokens_unknown"] or not attempts_complete or retry_accounting["conflicts"]
        or retry_accounting["missing_or_invalid_job_counts"] or retry_accounting["job_retried_calls"]
        or result["missing_or_invalid_reported_counts"])
    retry_accounting["prior_retry_tokens"] = None if retry_accounting["prior_retry_tokens_unknown"] else 0
    result["retry_accounting"] = retry_accounting
    required_stages = [s for s in result["stages"] if s["stage"] == "verifier" or entry["attempt_kind"] == "original"]
    if (accepted and all(s["availability"] == "available" and s["reported_minus_call_rows"] == 0
                         and s["observed_rows"] == s["call_metadata_rows"] and s["profile"] != "unknown" for s in required_stages)
            and not total["calls_missing_or_partial_usage"] and not total["token_accounting_flags"]
            and result["reported_total_minus_call_rows"] == 0 and not result["missing_or_invalid_reported_counts"]
            and result["execution_mode"] != "unknown" and not total["model_identity_unavailable"]
            and not total["model_identity_mismatches"] and total["calls_with_capture_identity"] == len(all_calls)
            and total["finish_counts"] == {"stop": len(all_calls)} and not total["error_calls"]
            and attempts_complete and not total["prior_retry_tokens_unknown"] and retry_accounting["job_retried_calls"] == 0
            and retry_accounting["job_total_calls"] == len(all_calls) and not retry_accounting["conflicts"]
            and result["lineage"]["status"] == "joined" and not unclassified
            and all(v == 0 for v in result["cardinality"]["observed_minus_reported"].values())):
        result["accepted_card_token_cost"] = {"denominator_recorded_entailed_cards": len(accepted),
            "numerator_call_metadata_rows": total["call_metadata_rows"],
            "tokens_per_recorded_entailed_card": {k: total["known_usage"][k] / len(accepted) for k in TOKENS}}
    return result, all_calls


def report_efficiency(inputs, inputs_sha256, out_dir, *, materialize=False):
    store = Inputs()
    inventory_ref = {"path": str(inputs), "sha256": inputs_sha256}
    inventory = store.obj(inventory_ref)
    require(set(inventory) == {"schema_version", "attempts"} and type(inventory["schema_version"]) is int
            and inventory["schema_version"] == 1, "bad_inventory_schema")
    require(isinstance(inventory["attempts"], list) and inventory["attempts"], "attempts_required")
    out = safe_path(out_dir)
    require(not os.path.lexists(out) and out.parent.is_dir(), "new_output_existing_parent_required")
    seen, owned_results, roles = set(), set(), {}
    for entry in inventory["attempts"]:
        require(isinstance(entry, dict) and {"work_id", "attempt_id", "attempt_kind", "job", "validation"} <= set(entry)
                and set(entry) <= {"work_id", "attempt_id", "attempt_kind", "job", "validation", "generator", "verifier"},
                "bad_attempt_schema")
        key = (identity(entry["work_id"]), identity(entry["attempt_id"]))
        require(key not in seen, "duplicate_attempt_id")
        seen.add(key)
        require(entry["attempt_kind"] in ("original", "reverify"), "bad_attempt_kind")
        for name in ("job", "validation", "generator", "verifier"):
            if name in entry:
                path = store.register(entry[name])
                require(path not in roles or roles[path] == name, "conflicting_artifact_roles")
                roles[path] = name
                if name == "verifier" or (name == "generator" and entry["attempt_kind"] == "original"):
                    require((name, path) not in owned_results, "duplicate_result_reference")
                    owned_results.add((name, path))
    require(not any(out == p or out in p.parents for p in store.pins), "output_contains_input")
    attempts, calls, per_attempt_calls = [], [], []
    physical_results = set()
    for entry in inventory["attempts"]:
        result, captured = diagnose_attempt(entry, store.obj(entry["job"]), store.obj(entry["validation"]), store)
        for stage in ("generator", "verifier"):
            if stage in entry and not (stage == "generator" and entry["attempt_kind"] == "reverify"):
                path = Path(entry[stage]["path"])
                if path in store.files and result["state"] != "pending":
                    info = store.files[path][1]
                    physical = (info.st_dev, info.st_ino)
                    require(physical not in physical_results, "duplicate_physical_result_reference")
                    physical_results.add(physical)
        attempts.append(result)
        per_attempt_calls.append(captured)
        calls.extend((entry["attempt_kind"], *call) for call in captured)
    pending = any(a["state"] == "pending" for a in attempts)
    # Reused generators have been indexed for lineage, without counting their calls.
    if not pending:
        for path, pin in store.pins.items():
            store.read({"path": str(path), "sha256": pin})
    groups = {}
    origins = Counter(call[-1] for call in calls if call[-1])
    for attempt, captured in zip(attempts, per_attempt_calls):
        duplicate_rows = sum(bool(call[-1]) and origins[call[-1]] > 1 for call in captured)
        attempt["rows_with_suspected_duplicate_origin"] = duplicate_rows
        if duplicate_rows:
            attempt["accepted_card_token_cost"] = None
    for kind, stage, mode, profile, meta, expected, origin in calls:
        groups.setdefault((kind, stage, mode, profile), []).append((meta, expected, origin))
    row_totals = summarize_calls([(c[-3], c[-2], c[-1]) for c in calls])
    if any(a["state"] == "pending" or a["retry_accounting"]["prior_retry_tokens_unknown"] for a in attempts):
        row_totals.update(prior_retry_tokens_unknown=True, prior_retry_tokens=None)
    result = {"schema_version": 1, "dry_run": not materialize, "snapshot_accepted": not pending,
              "scope": "attempt-row metadata totals, not unique provider compute, final quality, prevalence, recall, actual VRAM or currency",
              "unique_provider_compute_known": False,
              "capture_identity_limit": "lexically normalized claimed origins only; captures are not opened and copied metadata cannot prove actual inference",
              "suspected_duplicate_capture_origins": [{"origin_sha256": origin, "rows": n}
                                                     for origin, n in sorted(origins.items()) if n > 1],
              "quality_certified": False, "no_runtime_effect": True, "inventory": inventory_ref,
              "counts": {"attempts": len(attempts), "works": len({a["work_id"] for a in attempts}),
                         "pending_attempts": sum(a["state"] == "pending" for a in attempts), "call_metadata_rows": len(calls)},
              "attempts": attempts, "attempt_row_totals": row_totals,
              "by_stage": [{"attempt_kind": k, "stage": s, "execution_mode": m, "profile": p,
                            **summarize_calls(items)} for (k, s, m, p), items in sorted(groups.items())],
              "first_pass_by_stage": [{"stage": s, "execution_mode": m, "profile": p, **summarize_calls(items)}
                                      for (k, s, m, p), items in sorted(groups.items()) if k == "original"],
              "first_pass_scope": "explicit original attempts, including any separately inventoried retries; no chronological first-attempt inference",
              "input_refs": [{"path": str(p), "sha256": pin, "read": p in store.files}
                             for p, pin in sorted(store.pins.items(), key=lambda item: str(item[0]))]}
    payload = encoded(result)
    store.recheck()
    require(not materialize or not pending, "pending_snapshot_not_materializable")
    if materialize:
        require(safe_path(out) == out and not os.path.lexists(out), "output_already_exists")
        out.mkdir()
        with (out / "inference_efficiency.json").open("xb") as handle:
            handle.write(payload)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", required=True)
    parser.add_argument("--inputs-sha256", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--materialize", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = report_efficiency(args.inputs, args.inputs_sha256, args.out_dir, materialize=args.materialize)
    except (OSError, ValueError, TypeError, RecursionError):
        print("FAIL: snapshot_rejected", file=sys.stderr)
        return 2
    print(encoded(result).decode("utf-8"), end="")
    return 0 if result["snapshot_accepted"] else 3


if __name__ == "__main__":
    raise SystemExit(main())
