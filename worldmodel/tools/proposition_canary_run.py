#!/usr/bin/env python3
"""Offline-preflighted, fail-stop proposition canary. All outputs are review-only.

One generator request per window, one independent verifier request per valid
card. No retries, promotion, cross-work transfer, or quality certification.
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from typing import Any, Mapping, Sequence

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
BASE = os.path.join(REPO, "runs", "_extraction_scheduler", "20260924")
JOB_ID = "proposition_canary_v1"
CANARY_BOOKS_3 = ("黎明之剑", "疯巫妖的实验日志", "异常生物见闻录_远瞳")
FOUNDATION_EXT_3 = ("纣临", "网游之亡者征途", "贩罪")
_V2 = ("source_bound_foundation_v2_clean",
       "source_index_foundation_v2_clean/sentences_clean_v2clean.jsonl")
BOOKS = dict.fromkeys(CANARY_BOOKS_3 + FOUNDATION_EXT_3, _V2)
BOOKS["异常生物见闻录_远瞳"] = (
    "source_bound_foundation_v1", "source_index_foundation_v1/sentences_clean_v1.jsonl")
_WAVEA = ("source_bound_wavea_v1", "source_index_wavea_v1/sentences_clean_v1.jsonl")
_WAVEA_COVERAGE_ROOT = "c01_coverage_partition_wavea_v1"
CANARY_BOOKS = CANARY_BOOKS_3
COVERAGE_ROOT = "c01_coverage_partition_foundation_v1"
GEN_PROMPT = "proposition_canary_prompts/proposition_generator_prompt_v1.txt"
VER_PROMPT = "proposition_canary_prompts/proposition_verifier_prompt_v1.txt"
VER_PROMPT_CONTRACT = "proposition_canary_prompts/proposition_verifier_prompt_v3_acceptance_contract_2.txt"
PRIMARY_ROUTES = (
    "mechanism", "bounded_event", "entity_profile", "relationship_institution",
    "environment_location", "attributed_context", "tactic_context", "source_noise_fragment",
)
ASSERTION_STATUS = (
    "narrator_asserted", "formally_enacted_direct", "direct_speech_claim", "reported_belief",
    "rumor", "conjecture", "historical_account", "prophecy_or_plan",
)
TEMPORAL_STATUS = (
    "persistent_or_general", "bounded_occurrence", "historical", "future_or_contingent", "unknown",
)
EVIDENCE_DIRECTNESS = ("explicit", "inferred")
GENERALITY_SCOPE = ("instance", "entity_scoped", "class_scoped", "world_general", "unclear")
VERDICTS = ("entailed", "insufficient", "contradicted")
CONTRACT_OVERALL = ("entailed", "insufficient_evidence", "contradicted", "abstain")
OVERALL_TO_VERDICT = {
    "entailed": "entailed", "insufficient_evidence": "insufficient",
    "contradicted": "contradicted", "abstain": "insufficient",
}
CARD_KEYS = (
    "primary_route", "proposition_text", "evidence_ids", "evidence_spans",
    "assertion_status", "temporal_status", "evidence_directness", "content_facets",
    "generality_scope", "claimant_or_source",
)
# Fixed coverage, deliberately not derived from whichever fields a model emits.
REQUIRED_VERIFIER_FIELDS = (
    "primary_route", "proposition_text", "assertion_status", "temporal_status",
    "evidence_directness", "content_facets", "generality_scope", "claimant_or_source",
)
VERDICT_PRECEDENCE = ("contradicted", "insufficient_evidence", "abstain", "entailed")
MAX_CARDS_PER_WINDOW = 3
SMOKE_WINDOWS = 5
TIMEOUT_S = 900


class CallContractError(ValueError):
    """Only locally assigned, credential-free envelope error codes."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_file(path: str) -> str:
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def strict_json(content):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate_json_key")
            result[key] = value
        return result

    def constant(value):
        raise ValueError("nonfinite_json_number")

    return json.loads(content, object_pairs_hook=pairs, parse_constant=constant)


def read_jsonl(path: str) -> list[dict[str, Any]]:
    with open(path, encoding="utf-8") as handle:
        rows = [strict_json(line) for line in handle if line.strip()]
    if any(not isinstance(row, dict) for row in rows):
        raise ValueError("jsonl_row_not_object")
    return rows


def append_json(path, row):
    with open(path, "a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def write_json(path, value):
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def capture_bytes(path, value):
    with open(path, "xb") as handle:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())


def load_profile(name: str = "structured_source") -> dict[str, Any]:
    with open(os.path.join(REPO, "worker_config.json"), encoding="utf-8") as handle:
        profile = strict_json(handle.read())["profiles"][name]
    endpoint = urllib.parse.urlsplit(profile["endpoint"])
    if endpoint.username is not None or endpoint.password is not None or endpoint.query or endpoint.fragment:
        raise SystemExit("FAIL: credential-bearing/query endpoints cannot be written to job artifacts")
    return profile


def split_prompt(path: str) -> tuple[str, str]:
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    if "[SYSTEM]" not in text or "[USER]" not in text:
        raise SystemExit(f"FAIL: prompt markers missing: {path}")
    prefix, rest = text.split("[SYSTEM]", 1)
    system, user = rest.split("[USER]", 1)
    if prefix.strip() or not user.strip():
        raise SystemExit(f"FAIL: malformed prompt: {path}")
    return system.strip("\n"), user.strip("\n")


def render(template: str, mapping: Mapping[str, str]) -> str:
    # One pass: source text cannot introduce another template substitution.
    return re.sub(r"\{([a-z_]+)\}", lambda m: str(mapping.get(m[1], m[0])), template)


def call_model(profile: Mapping[str, Any], messages: Sequence[Mapping[str, str]],
               max_tokens: int, thinking_disabled: bool = True, *,
               capture_dir=None) -> dict[str, Any]:
    """Exactly one HTTP attempt; persist bodies before any envelope processing.

    Only the request body is captured, never headers, credentials, or exception
    messages. A capture directory is absent-only, including after interruption.
    """
    payload_body = {"model": profile["model"], "messages": list(messages),
                    "temperature": 0, "max_tokens": max_tokens}
    if thinking_disabled:
        payload_body["chat_template_kwargs"] = {"enable_thinking": False}
    body = json.dumps(payload_body, ensure_ascii=False).encode("utf-8")
    journal = None
    if capture_dir is not None:
        os.makedirs(capture_dir, exist_ok=False)
        journal = os.path.join(capture_dir, "journal.jsonl")
        capture_bytes(os.path.join(capture_dir, "request_body.bin"), body)
        append_json(journal, {"stage": "request_saved", "sha256": hashlib.sha256(body).hexdigest()})
    headers = {"Content-Type": "application/json"}
    api_key = os.environ.get(profile.get("api_key_env") or "", "")
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    meta = {"attempts": 1, "http_status": None, "model": None,
            "finish_reason": None, "usage": None, "content": "", "error": None}
    if capture_dir is not None:
        meta["capture_dir"] = os.fspath(capture_dir)

    def save_response(raw, incomplete=False):
        if journal:
            capture_bytes(os.path.join(capture_dir, "response_body.bin"), raw)
            append_json(journal, {"stage": "response_incomplete" if incomplete else "response_saved",
                                  "http_status": meta["http_status"],
                                  "sha256": hashlib.sha256(raw).hexdigest()})

    def read_response(response):
        try:
            raw = response.read()
        except http.client.IncompleteRead as error:
            meta["response_incomplete"] = True
            save_response(error.partial, incomplete=True)
            raise
        save_response(raw)
        return raw

    request = urllib.request.Request(profile["endpoint"], data=body, headers=headers, method="POST")
    try:
        try:
            # A redirect is a failed response, never a hidden second HTTP request.
            with urllib.request.build_opener(NoRedirect).open(request, timeout=TIMEOUT_S) as response:
                meta["http_status"] = response.status
                raw = read_response(response)  # Save before response.__exit__, which can interrupt.
        except urllib.error.HTTPError as error:
            meta["http_status"] = error.code
            raw = read_response(error)
        if meta["http_status"] != 200:
            raise CallContractError(f"http_{meta['http_status']}")
        payload = strict_json(raw.decode("utf-8"))
        if not isinstance(payload, dict) or payload.get("model") != profile["model"]:
            raise CallContractError("response_model_mismatch")
        meta["model"] = payload["model"]
        choices = payload.get("choices")
        if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
            raise CallContractError("response_choices_not_one")
        choice = choices[0]
        meta["finish_reason"] = choice.get("finish_reason")
        if meta["finish_reason"] != "stop":
            raise CallContractError("response_finish_not_stop")
        message = choice.get("message")
        if not isinstance(message, dict) or not isinstance(message.get("content"), str):
            raise CallContractError("response_content_not_string")
        meta["content"] = message["content"]
        meta["usage"] = payload.get("usage")
    except Exception as error:
        meta["error"] = str(error) if isinstance(error, CallContractError) else type(error).__name__
    except BaseException as error:
        if journal:
            append_json(journal, {"stage": "interrupted", "error": type(error).__name__})
        raise
    meta["content_sha256"] = sha256_text(meta["content"])
    if journal:
        append_json(journal, {"stage": "envelope_validated", "error": meta["error"]})
    return meta


def parse_strict(content: str) -> tuple[dict[str, Any] | None, str | None]:
    if not isinstance(content, str) or not content.strip():
        return None, "empty_response"
    try:
        value = strict_json(content)
    except (ValueError, TypeError):
        return None, "invalid_json"
    if not isinstance(value, dict):
        return None, "not_an_object"
    return value, None


def parse_verdict_block(content: str) -> tuple[dict[str, Any] | None, list[str]]:
    if not isinstance(content, str) or not content.strip():
        return None, ["empty_response"]
    # Count even malformed/hidden duplicates, not just complete blocks in the tail.
    if content.count("<VERDICT_JSON>") > 1 or content.count("</VERDICT_JSON>") > 1:
        return None, ["verdict_block_duplicate"]
    tail = content.split("</think>", 1)[1] if "</think>" in content else content
    blocks = list(re.finditer(r"<VERDICT_JSON>(.*?)</VERDICT_JSON>", tail, re.DOTALL))
    if not blocks:
        return None, ["verdict_block_absent"]
    block = blocks[0]
    if tail[block.end():].strip():
        return None, ["verdict_block_trailing"]
    try:
        value = strict_json(block[1].strip())
    except ValueError:
        return None, ["verdict_block_malformed"]
    if not isinstance(value, dict):
        return None, ["verdict_block_not_object"]
    return value, []


def build_window(record: Mapping[str, Any], sentences: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    chapter = record.get("chapter_id")
    if not isinstance(chapter, str) or not re.fullmatch(r"B\d+:C\d+", chapter):
        raise ValueError("invalid_chapter_id")
    if not isinstance(record.get("window_id"), str) or not record["window_id"].strip():
        raise ValueError("invalid_window_id")
    anchors, attached = record.get("anchor_sentence_ids"), record.get("attached_sentence_ids", [])
    if not isinstance(anchors, list) or not anchors or not isinstance(attached, list):
        raise ValueError("invalid_source_ids")
    ids = anchors + attached
    if any(not isinstance(sid, str) for sid in ids) or len(ids) != len(set(ids)):
        raise ValueError("duplicate_or_malformed_source_ids")
    for sid in ids:
        if sid not in sentences:
            raise ValueError(f"missing_source_id:{sid}")
        source = sentences[sid]
        if not re.fullmatch(re.escape(chapter) + r":S\d+", sid):
            raise ValueError(f"sentence_chapter_prefix_mismatch:{sid}")
        if source.get("sentence_id") != sid or source.get("chapter_id") != chapter:
            raise ValueError(f"sentence_binding_mismatch:{sid}")
        if not isinstance(source.get("text"), str) or not source["text"].strip():
            raise ValueError(f"invalid_source_text:{sid}")
        if record.get("work_id") is not None and source.get("work_id") is not None:
            if record["work_id"] != source["work_id"]:
                raise ValueError("source_work_mismatch")
    return {"window_id": record["window_id"], "chapter_id": chapter,
            "role": record.get("role"), "sentence_ids": ids,
            "sentences_block": "\n".join(f"{sid}|{sentences[sid]['text']}" for sid in ids),
            "sentence_text": {sid: sentences[sid]["text"] for sid in ids}}


def preflight_sources(coverage_rows, sentence_rows, book, roles, limit):
    sentences, seen_windows = {}, set()
    for source in sentence_rows:
        sid = source.get("sentence_id")
        if not isinstance(sid, str) or sid in sentences:
            raise ValueError("duplicate_or_invalid_sentence_id")
        if source.get("work_id") is not None and source["work_id"] != book:
            raise ValueError("sentence_work_mismatch")
        sentences[sid] = source
    coverage = []
    for row in coverage_rows:
        wid = row.get("window_id")
        if not isinstance(wid, str) or not wid.strip() or wid in seen_windows:
            raise ValueError("duplicate_or_invalid_window_id")
        seen_windows.add(wid)
        if row.get("work_id") is not None and row["work_id"] != book:
            raise ValueError("window_work_mismatch")
        if row.get("role") in roles:
            coverage.append(row)
    if limit > 0:
        coverage = coverage[:limit]
    # Build every requested window before dispatch, not only the smoke prefix.
    windows = [build_window(row, sentences) for row in coverage]
    return coverage, sentences, windows


def validate_card(card: Any, window: Mapping[str, Any]) -> tuple[dict[str, Any] | None, list[str]]:
    if not isinstance(card, dict):
        return None, ["card_not_object"]
    errors = [f"missing_key:{key}" for key in CARD_KEYS if key not in card]
    errors.extend(f"unknown_key:{key}" for key in card if key not in CARD_KEYS)
    if errors:
        return None, errors
    for key, vocabulary in (("primary_route", PRIMARY_ROUTES), ("assertion_status", ASSERTION_STATUS),
                            ("temporal_status", TEMPORAL_STATUS), ("evidence_directness", EVIDENCE_DIRECTNESS),
                            ("generality_scope", GENERALITY_SCOPE)):
        if not isinstance(card[key], str) or card[key] not in vocabulary:
            errors.append(f"bad_{key}")
    if not isinstance(card["proposition_text"], str) or not card["proposition_text"].strip():
        errors.append("empty_proposition_text")
    claimant = card["claimant_or_source"]
    if claimant is not None and (not isinstance(claimant, str) or not claimant.strip()):
        errors.append("bad_claimant_or_source")
    facets = card["content_facets"]
    if (not isinstance(facets, list) or not facets
            or any(not isinstance(f, str) or f not in PRIMARY_ROUTES for f in facets)):
        errors.append("bad_content_facets")
    elif len(facets) != len(set(facets)):
        errors.append("duplicate_content_facets")
    evidence_ids, spans = card["evidence_ids"], card["evidence_spans"]
    ids_ok = isinstance(evidence_ids, list) and bool(evidence_ids) and all(
        isinstance(sid, str) and sid in window["sentence_text"] for sid in evidence_ids)
    if not ids_ok:
        errors.append("bad_evidence_ids")
    elif len(evidence_ids) != len(set(evidence_ids)):
        errors.append("duplicate_evidence_ids")
    span_ids, seen_spans = set(), set()
    if not isinstance(spans, list) or not spans:
        errors.append("no_evidence_spans")
    else:
        for span in spans:
            if not isinstance(span, dict) or set(span) != {"sentence_id", "start", "end"}:
                errors.append("bad_evidence_span_shape")
                continue
            sid, start, end = span["sentence_id"], span["start"], span["end"]
            if not isinstance(sid, str) or sid not in window["sentence_text"]:
                errors.append("span_sentence_not_in_window")
                continue
            if type(start) is not int or type(end) is not int:
                errors.append("span_offsets_not_int")
                continue
            if not 0 <= start < end <= len(window["sentence_text"][sid]):
                errors.append("span_out_of_bounds")
                continue
            identity = (sid, start, end)
            if identity in seen_spans:
                errors.append("duplicate_evidence_span")
            seen_spans.add(identity)
            span_ids.add(sid)
    if ids_ok and span_ids != set(evidence_ids):
        errors.append("evidence_ids_span_mismatch")
    if errors:
        return None, errors
    # Literal offsets establish provenance only, never semantic entailment.
    return {key: card[key] for key in CARD_KEYS}, []


def render_evidence(card: Mapping[str, Any], window: Mapping[str, Any]) -> str:
    return "\n".join(f"{s['sentence_id']}|{window['sentence_text'][s['sentence_id']][s['start']:s['end']]}"
                     for s in card["evidence_spans"])


def parse_verifier_card(vmeta, case_id, window, card=None, expected_model=None):
    """Return (verdict, overall, checks, cited, errors); errors never certify."""
    payload, errors = parse_verdict_block(vmeta.get("content"))
    if vmeta.get("error") or vmeta.get("http_status") != 200:
        errors.append("verifier_call_failed")
    if vmeta.get("finish_reason") != "stop":
        errors.append("verifier_finish_not_stop")
    if expected_model is None or vmeta.get("model") != expected_model:
        errors.append("verifier_model_mismatch")
    normalized, card_errors = validate_card(card, window)
    if card_errors or normalized != card:
        errors.append("normalized_card_required")
    overall, checks, cited = None, [], []
    if payload is not None:
        if set(payload) != {"case_id", "overall", "checks", "no_runtime_effect"}:
            errors.append("bad_verifier_shape")
        overall = payload.get("overall")
        if not isinstance(overall, str) or overall not in CONTRACT_OVERALL:
            errors.append("bad_overall")
        if payload.get("case_id") != case_id:
            errors.append("case_id_mismatch")
        if payload.get("no_runtime_effect") is not True:
            errors.append("no_runtime_effect_missing")
        checks = payload.get("checks")
        if not isinstance(checks, list) or not checks:
            errors.append("checks_required")
            checks = []
        fields, check_verdicts = set(), []
        allowed = set(normalized["evidence_ids"]) if normalized is not None else set()
        for check in checks:
            if not isinstance(check, dict) or set(check) != {"field_path", "verdict", "evidence_ids", "reason"}:
                errors.append("bad_check_shape")
                continue
            field, verdict = check["field_path"], check["verdict"]
            if not isinstance(field, str) or field not in REQUIRED_VERIFIER_FIELDS:
                errors.append("bad_field_path")
            elif field in fields:
                errors.append("duplicate_field_path")
            else:
                fields.add(field)
            if not isinstance(verdict, str) or verdict not in CONTRACT_OVERALL:
                errors.append("bad_check_verdict")
            else:
                check_verdicts.append(verdict)
            if not isinstance(check["reason"], str) or not check["reason"].strip():
                errors.append("bad_check_reason")
            ids = check["evidence_ids"]
            if not isinstance(ids, list) or not ids or any(not isinstance(cid, str) for cid in ids):
                errors.append("check_citations_required")
            else:
                if len(ids) != len(set(ids)):
                    errors.append("duplicate_check_citation")
                for cid in ids:
                    if cid not in allowed:
                        errors.append("cited_outside_sent_card_evidence")
                    elif cid not in cited:
                        cited.append(cid)
            if (normalized is not None and field == "claimant_or_source"
                    and normalized["claimant_or_source"] is None
                    and normalized["assertion_status"] != "narrator_asserted"
                    and verdict != "insufficient_evidence"):
                errors.append("unresolved_claimant_requires_insufficient")
        if fields != set(REQUIRED_VERIFIER_FIELDS):
            errors.append("required_field_coverage")
        reconciled = next((v for v in VERDICT_PRECEDENCE if v in check_verdicts), None)
        if overall != reconciled:
            errors.append("overall_check_mismatch")
    return (OVERALL_TO_VERDICT.get(overall) if isinstance(overall, str) and not errors else None,
            overall, checks, cited, errors)


def bind_reverify(gen_jsonl, book, windows, input_hashes):
    """Use original job hashes, not inferred source paths, as binding authority."""
    with open(gen_jsonl, "rb") as handle:
        gen_bytes = handle.read()
    gen_sha = hashlib.sha256(gen_bytes).hexdigest()
    with open(os.path.join(os.path.dirname(gen_jsonl), "job_record.json"), encoding="utf-8") as handle:
        job = strict_json(handle.read())
    if not isinstance(job, dict):
        raise ValueError("original_job_not_object")
    if job.get("book") != book:
        raise ValueError("original_job_book_mismatch")
    generator_model = job.get("model")
    if not isinstance(generator_model, str) or not generator_model.strip():
        raise ValueError("original_generator_model_missing")
    original_hashes = job.get("input_artifact_hashes", {})
    if not isinstance(original_hashes, dict):
        raise ValueError("original_source_hashes_not_object")
    bindings = {}
    for key in ("coverage_partition.jsonl", "sentences.jsonl"):
        if not original_hashes.get(key) or original_hashes[key] != input_hashes.get(key):
            raise ValueError(f"original_source_hash_mismatch:{key}")
        bindings[key] = original_hashes[key]
    rows = [strict_json(line) for line in gen_bytes.decode("utf-8").splitlines() if line.strip()]
    if any(not isinstance(row, dict) for row in rows):
        raise ValueError("original_row_not_object")
    if type(job.get("total_windows")) is not int or job["total_windows"] != len(rows):
        raise ValueError("original_generator_window_count_mismatch")
    by_id = {window["window_id"]: window for window in windows}
    if len(by_id) != len(windows):
        raise ValueError("duplicate_reverify_window_id")
    seen_windows, seen_cards, selected = set(), set(), []
    for row in rows:
        wid = row.get("window_id")
        if not isinstance(wid, str) or wid in seen_windows or wid not in by_id:
            raise ValueError("original_window_missing_or_duplicate")
        seen_windows.add(wid)
        window = by_id[wid]
        # Legacy generator rows have allowed_work_ids but no work_id.
        if row.get("work_id", book) != book or row.get("allowed_work_ids") != [book]:
            raise ValueError("original_row_work_mismatch")
        ids = row.get("sentence_ids")
        if (row.get("chapter_id") != window["chapter_id"] or not isinstance(ids, list)
                or any(not isinstance(sid, str) for sid in ids) or len(ids) != len(set(ids))
                or set(ids) != set(window["sentence_ids"])):
            raise ValueError("original_row_source_binding_mismatch")
        meta = row.get("call_meta")
        if (not isinstance(meta, dict) or type(meta.get("http_status")) is not int
                or meta["http_status"] != 200 or meta.get("model") != generator_model
                or meta.get("finish_reason") != "stop" or "error" not in meta or meta["error"] is not None
                or row.get("model_parse_ok") is not True or "parse_error" not in row
                or row["parse_error"] is not None or meta.get("response_incomplete")):
            raise ValueError("original_generator_call_invalid")
        payload, parse_error = parse_strict(row.get("raw_response"))
        if (parse_error or set(payload) != {"propositions"}
                or not isinstance(payload["propositions"], list)
                or len(payload["propositions"]) > MAX_CARDS_PER_WINDOW):
            raise ValueError("original_generator_envelope_invalid")
        proposed = payload["propositions"]
        cards = row.get("cards")
        if not isinstance(cards, list):
            raise ValueError("original_cards_not_list")
        if (type(row.get("proposed_count")) is not int or row["proposed_count"] != len(proposed)
                or len(cards) != len(proposed)):
            raise ValueError("original_generator_card_count_mismatch")
        for index, item in enumerate(cards):
            if not isinstance(item, dict):
                raise ValueError("original_card_not_object")
            cid = item.get("card_id")
            if (not isinstance(cid, str) or not cid.strip() or cid in seen_cards
                    or item.get("window_id") != wid or item.get("chapter_id") != window["chapter_id"]
                    or item.get("work_id") != book or item.get("allowed_work_ids") != [book]):
                raise ValueError("original_card_binding_mismatch")
            seen_cards.add(cid)
            if (cid != f"{wid}#{index}" or json.dumps(item.get("generator_card"), sort_keys=True)
                    != json.dumps(proposed[index], sort_keys=True)):
                raise ValueError("original_generator_card_correspondence_mismatch")
            normalized, errors = validate_card(item.get("generator_card"), window)
            if errors or item.get("accepted_for_verification") is not True or item.get("schema_errors") != []:
                raise ValueError("original_card_schema_or_span_rejected")
            stored, stored_errors = validate_card(item.get("normalized_card"), window)
            if errors or stored_errors or normalized != stored or stored != item["normalized_card"]:
                raise ValueError("original_normalized_card_mismatch")
            if item.get("route") != normalized["primary_route"]:
                raise ValueError("original_route_mismatch")
            selected.append((window, dict(item)))
    if seen_windows != set(by_id):
        raise ValueError("original_requested_windows_missing")
    return rows, selected, {"source_generator_jsonl": os.path.abspath(gen_jsonl),
                            "source_generator_jsonl_sha256": gen_sha,
                            "source_bindings": bindings, "source_book": book}


def refuse_existing(out_dir):
    if os.path.lexists(out_dir):
        raise SystemExit(f"FAIL: absent-only: {out_dir} exists; use a fresh --out-dir; --overwrite cannot replace evidence")


def execute(arguments, book, windows, profile, verifier_profile, gen_prompt, ver_prompt,
            input_hashes, gen_name, reverify=None):
    out_dir = arguments.out_dir or os.path.join(BASE, JOB_ID, book,
                                               *(["reverify_8001"] if reverify else []))
    refuse_existing(out_dir)
    os.makedirs(out_dir, exist_ok=False)
    generator_rows, verifier_rows = [], []
    stages = os.path.join(out_dir, "stage_journal.jsonl")
    counters = dict.fromkeys((
        "windows_processed", "windows_requested", "window_errors", "proposer_cards",
        "cards_schema_or_span_rejected", "cards_verified", "cards_valid", "cards_unusable",
        "cards_unattempted", "generator_attempts", "verifier_attempts", "generation_errors",
        "envelope_errors", "verifier_contract_errors", "source_binding_errors", "failures", "total_calls",
    ), 0)
    counters["windows_requested"] = len(windows)
    verdict_counts, finish_reasons, verifier_errors_count = Counter(), Counter(), Counter()
    failed_windows, attempted_windows, completed_windows = set(), set(), set()
    attempted_cards, all_cards = set(), []
    failure = None
    binding = reverify[2] if reverify else {}
    gen_rel, ver_rel = arguments.gen_prompt, arguments.ver_prompt
    job = {
        "job_id": arguments.job_id, "book": book, "status": "running",
        "acceptance_contract_version": 2, "quality_certified": False,
        "execution_mode": "verifier_only_reverify_8001" if reverify else (
            "structured_source" if gen_name == "structured_source" else f"degraded_generation_{gen_name}"),
        "result_class": "proposition_canary_measurement", "promotes_nothing": True,
        "automatic_promotion_permitted": False, "input_artifact_hashes": input_hashes,
        "generator_profile": gen_name, "endpoint": profile["endpoint"], "model": profile["model"],
        "verifier_endpoint": verifier_profile["endpoint"], "verifier_model": verifier_profile["model"],
        "thinking_disabled": True, "verifier_thinking_disabled": False,
        "max_model_len": profile.get("max_model_len"), "max_num_seqs": profile.get("max_num_seqs"),
        "max_tokens": arguments.max_tokens, "ver_max_tokens": arguments.ver_max_tokens, "temperature": 0,
        "roles": sorted(arguments.roles.split(",")), "generator_reused": bool(reverify),
        "generator_prompt_path": gen_rel, "verifier_prompt_path": ver_rel,
        "generator_prompt_sha256": input_hashes[gen_rel], "verifier_prompt_sha256": input_hashes[ver_rel],
        "contract": "handoff_dual_endpoint_prompt_contract_20261010.md",
        "acceptance_contract": "proposition_acceptance_contract_v2",
        "boundaries": {"publication_status": "candidate_not_confirmed", "transfer_policy": "no_transfer",
                       "review_only": True, "cross_book_merge": False, "runtime_effect": False,
                       "stage_23": False, "d02_registry": False, "model_scores_used_as_evidence": False},
        **binding,
    }
    if reverify:
        job.update(endpoint=verifier_profile["endpoint"], model=verifier_profile["model"],
                   generator_jsonl=binding["source_generator_jsonl"],
                   generator_jsonl_sha256=binding["source_generator_jsonl_sha256"])
    write_json(os.path.join(out_dir, "job_record.json"), job)

    def fail(stage, wid, errors, card_id=None):
        nonlocal failure
        failure = {"stage": stage, "window_id": wid, "card_id": card_id, "errors": errors}
        if wid is not None:
            failed_windows.add(wid)
        append_json(os.path.join(out_dir, "failures.jsonl"), failure)
        append_json(stages, {"stage": "failed", "failure": failure})

    def dispatch(stage, wid, messages, model_profile, tokens, card_id=None):
        counters["total_calls"] += 1
        counters[stage + "_attempts"] += 1
        call_dir = os.path.join(out_dir, "calls", f"{counters['total_calls']:06d}_{stage}")
        append_json(stages, {"stage": stage + "_started", "window_id": wid,
                             "card_id": card_id, "capture_dir": os.path.relpath(call_dir, out_dir)})
        meta = call_model(model_profile, messages, tokens, thinking_disabled=stage == "generator",
                          capture_dir=call_dir)
        append_json(stages, {"stage": stage + "_returned", "window_id": wid, "card_id": card_id,
                             "call_meta": {k: v for k, v in meta.items() if k != "content"}})
        finish_reasons[str(meta.get("finish_reason"))] += 1
        if (meta.get("error") or meta.get("http_status") != 200
                or meta.get("model") != model_profile["model"] or meta.get("finish_reason") != "stop"
                or not isinstance(meta.get("content"), str)):
            counters["envelope_errors"] += 1
            if meta.get("http_status") != 200:
                counters["failures"] += 1
            fail(stage, wid, [meta.get("error") or "invalid_call_envelope"], card_id)
        return meta

    def verify(window, row):
        normalized, cid = row["normalized_card"], row["card_id"]
        case_id = f"{book}|{window['window_id']}|{cid}"
        user = render(ver_prompt[1], {"work_id": book, "case_id": case_id,
                      "evidence_block": render_evidence(normalized, window),
                      "candidate_json": json.dumps(normalized, ensure_ascii=False)})
        attempted_cards.add(cid)
        meta = dispatch("verifier", window["window_id"],
                        [{"role": "system", "content": ver_prompt[0]}, {"role": "user", "content": user}],
                        verifier_profile, arguments.ver_max_tokens, cid)
        verdict, overall, checks, cited, errors = parse_verifier_card(
            meta, case_id, window, normalized, verifier_profile["model"])
        counters["cards_verified"] += 1  # Legacy: verifier result rows, including unusable results.
        if errors:
            counters["cards_unusable"] += 1
            counters["verifier_contract_errors"] += 1
            verifier_errors_count.update(error.split(":", 1)[0] for error in errors)
            if failure is None:
                fail("verifier_contract", window["window_id"], errors, cid)
        else:
            counters["cards_valid"] += 1
            verdict_counts[verdict] += 1
        row["verifier"] = {"verdict": verdict, "contract_overall": overall, "checks": checks,
                           "reason_codes": [], "cited_evidence_ids": cited, "errors": errors,
                           "prompt_sha256": sha256_text(user), "raw_response": meta["content"],
                           "call_meta": {k: v for k, v in meta.items() if k != "content"}}
        row["entailed"] = verdict == "entailed" and not errors
        verifier_rows.append(row)
        append_json(os.path.join(out_dir, "proposition_verifier.jsonl"), row)
        append_json(stages, {"stage": "verifier_result_saved", "card_id": cid, "valid": not errors})

    try:
        if windows:
            for name in ("checkpoint.jsonl", "failures.jsonl", "proposition_verifier.jsonl"):
                capture_bytes(os.path.join(out_dir, name), b"")
            if not reverify:
                capture_bytes(os.path.join(out_dir, "proposition_generator.jsonl"), b"")
        if reverify:
            selected = reverify[1]
            all_cards.extend(row for _, row in selected)
            counters["proposer_cards"] = len(all_cards)
            for window in windows:
                wid = window["window_id"]
                attempted_windows.add(wid)
                for card_window, row in selected:
                    if card_window["window_id"] != wid:
                        continue
                    verify(window, row)
                    if failure:
                        break
                if failure:
                    break
                completed_windows.add(wid)
                append_json(os.path.join(out_dir, "checkpoint.jsonl"),
                            {"window_id": wid, "status": "completed", "results_saved": True})
        else:
            for index, window in enumerate(windows):
                wid = window["window_id"]
                attempted_windows.add(wid)
                user = render(gen_prompt[1], {"work_id": book, "window_id": wid,
                              "chapter_id": window["chapter_id"], "sentences_block": window["sentences_block"]})
                meta = dispatch("generator", wid,
                                [{"role": "system", "content": gen_prompt[0]}, {"role": "user", "content": user}],
                                profile, arguments.max_tokens)
                payload, parse_error = parse_strict(meta["content"])
                cards = payload.get("propositions") if payload is not None else None
                if payload is not None and (set(payload) != {"propositions"} or not isinstance(cards, list)
                                            or len(cards) > MAX_CARDS_PER_WINDOW):
                    parse_error = "generator_schema"
                if parse_error and failure is None:
                    counters["generation_errors"] += 1
                    fail("generator_schema", wid, [parse_error])
                gen_row = {"window_id": wid, "work_id": book, "chapter_id": window["chapter_id"],
                           "role": window["role"], "sentence_ids": window["sentence_ids"],
                           "prompt_sha256": sha256_text(user), "raw_response": meta["content"],
                           "model_parse_ok": payload is not None, "parse_error": parse_error,
                           "call_meta": {k: v for k, v in meta.items() if k != "content"},
                           "publication_status": "candidate_not_confirmed", "transfer_policy": "no_transfer",
                           "review_status": "pending", "allowed_work_ids": [book],
                           "proposed_count": len(cards) if isinstance(cards, list) else 0, "cards": []}
                generator_rows.append(gen_row)
                # Validate the complete proposal before dispatching even its first verifier.
                if isinstance(cards, list):
                    counters["proposer_cards"] += len(cards)
                    for card_index, card in enumerate(cards):
                        normalized, errors = validate_card(card, window)
                        row = {"card_id": f"{wid}#{card_index}", "window_id": wid, "work_id": book,
                               "chapter_id": window["chapter_id"], "route": normalized["primary_route"] if normalized else None,
                               "generator_card": card, "schema_errors": errors,
                               "accepted_for_verification": normalized is not None,
                               "publication_status": "candidate_not_confirmed", "transfer_policy": "no_transfer",
                               "allowed_work_ids": [book]}
                        if normalized is not None:
                            row["normalized_card"] = normalized
                        else:
                            counters["cards_schema_or_span_rejected"] += 1
                            if failure is None:
                                fail("card_schema_or_span", wid, errors, row["card_id"])
                        gen_row["cards"].append(row)
                        all_cards.append(row)
                # The journal retains the proposal even if its verifier is interrupted.
                append_json(stages, {"stage": "generator_parsed", "window_id": wid,
                                     "proposal": gen_row})
                if failure is None:
                    for row in gen_row["cards"]:
                        verify(window, row)
                        if failure:
                            break
                append_json(os.path.join(out_dir, "proposition_generator.jsonl"), gen_row)
                append_json(stages, {"stage": "generator_result_saved", "window_id": wid})
                if failure:
                    break
                completed_windows.add(wid)
                append_json(os.path.join(out_dir, "checkpoint.jsonl"),
                            {"window_id": wid, "index": index, "status": "completed", "results_saved": True,
                             "proposed": gen_row["proposed_count"],
                             "accepted_for_verification": len(gen_row["cards"]),
                             "entailed": sum(bool(row.get("entailed")) for row in gen_row["cards"])})
        if reverify and sha256_file(binding["source_generator_jsonl"]) != binding["source_generator_jsonl_sha256"]:
            counters["source_binding_errors"] += 1
            fail("source_binding", None, ["generator_changed_during_reverify"])
    except BaseException as error:
        # KeyboardInterrupt/SystemExit also terminate dispatch and preserve a terminal record.
        counters["failures"] += 1
        fail("interrupted" if not isinstance(error, Exception) else "execution",
             window["window_id"] if "window" in locals() else None, [type(error).__name__])

    counters["windows_processed"] = len(attempted_windows)
    counters["window_errors"] = len(failed_windows)
    unattempted_windows = [w["window_id"] for w in windows if w["window_id"] not in attempted_windows]
    unattempted_cards = [row["card_id"] for row in all_cards
                         if row["accepted_for_verification"] and row["card_id"] not in attempted_cards]
    counters["cards_unattempted"] = len(unattempted_cards)
    counters["cards_unusable"] = counters["verifier_attempts"] - counters["cards_valid"]
    generation_complete = (bool(reverify) or (len(generator_rows) == len(windows)
                           and counters["generation_errors"] == 0
                           and counters["cards_schema_or_span_rejected"] == 0
                           and all(not row["call_meta"].get("error") for row in generator_rows)))
    verification_complete = (generation_complete and not unattempted_windows and not unattempted_cards
                             and counters["cards_unusable"] == 0
                             and counters["verifier_attempts"] == counters["cards_valid"])
    execution_complete = len(completed_windows) == len(windows)
    ok = failure is None and execution_complete and verification_complete
    status = ("no_eligible_windows" if not windows else "completed") if ok else "failed"
    report = {
        "acceptance_contract_version": 2, "ok": ok, "status": status,
        "execution_complete": execution_complete, "verification_complete": verification_complete,
        "generation_complete": generation_complete,
        "contract_errors": (counters["generation_errors"] + counters["envelope_errors"]
                            + counters["cards_schema_or_span_rejected"] + counters["verifier_contract_errors"]
                            + counters["source_binding_errors"]),
        "quality_certified": False, **counters,
        "windows_completed": len(completed_windows), "windows_unattempted": len(unattempted_windows),
        "unattempted_window_ids": unattempted_windows, "unattempted_card_ids": unattempted_cards,
        "cards_considered": sum(row["accepted_for_verification"] for row in all_cards),
        "verdicts": dict(sorted(verdict_counts.items())),
        "verifier_error_counts": dict(sorted(verifier_errors_count.items())),
        "candidate_output_written": bool(verifier_rows), "terminal_failure": failure,
        "checks": {"all_windows_accounted": len(attempted_windows) + len(unattempted_windows) == len(windows),
                   "all_windows_completed": execution_complete, "zero_transport_failures": counters["failures"] == 0,
                   "smoke_pass": not failed_windows, "no_eligible_windows": not windows}, **binding,
    }
    if reverify:
        report["mode"] = "verifier_only_reverify"
    route_counts = Counter(row["route"] for row in verifier_rows)
    entailed_counts = Counter(row["route"] for row in verifier_rows if row["entailed"])
    if windows:
        routes_dir = os.path.join(out_dir, "validated_route_queues")
        os.makedirs(routes_dir)
        for route in PRIMARY_ROUTES:
            path = os.path.join(routes_dir, route + ".jsonl")
            capture_bytes(path, b"")
            for row in verifier_rows:
                if row["entailed"] and row["route"] == route:
                    append_json(path, row)
        if not reverify:
            write_json(os.path.join(out_dir, "audit_sample_manifest.json"), {
                "method": "deterministic full entailed set; review-only",
                "per_route": {route: {"entailed": entailed_counts[route], "total": route_counts[route]}
                              for route in PRIMARY_ROUTES},
                "sample_rule": "review every route queue item; no quality certification"})
        append_json(stages, {"stage": "terminal", "status": status,
                              "unattempted_window_ids": unattempted_windows,
                              "unattempted_card_ids": unattempted_cards})
    # Bind every saved evidence file, including empty queues and the final journal.
    # The job and report are excluded to avoid a self-referential manifest.
    output_hashes = {}
    for directory, _, filenames in os.walk(out_dir):
        for name in filenames:
            path = os.path.join(directory, name)
            relative = os.path.relpath(path, out_dir).replace("\\", "/")
            if relative not in {"job_record.json", "validation_report.json"}:
                output_hashes[relative] = sha256_file(path)
    job.update(status=status, validation_result=status, total_windows=len(attempted_windows),
               total_cards=len(all_cards), total_calls=counters["total_calls"], retried_calls=0,
               failures=counters["failures"], finish_reason=dict(sorted(finish_reasons.items())),
               verdicts=report["verdicts"], smoke_result="pass" if ok else "fail",
               route_counts=dict(sorted(route_counts.items())), entailed_route_counts=dict(sorted(entailed_counts.items())),
                execution_complete=execution_complete, verification_complete=verification_complete,
                output_file_hashes=dict(sorted(output_hashes.items())),
               unattempted_window_ids=unattempted_windows, unattempted_card_ids=unattempted_cards,
               output_artifact={"directory": os.path.relpath(out_dir, BASE).replace("\\", "/"),
                                "files": sorted(os.listdir(out_dir) + ["validation_report.json"])})
    write_json(os.path.join(out_dir, "job_record.json"), job)
    write_json(os.path.join(out_dir, "validation_report.json"), report)
    print(f"[{status}] {book}: windows={len(attempted_windows)}/{len(windows)} calls={counters['total_calls']} out={out_dir}")
    return 0 if ok else 1


def run_verifier_only(arguments, book, coverage, sentences, verifier_profile,
                      ver_system, ver_user, ver_rel, input_hashes) -> int:
    windows = [build_window(record, sentences) for record in coverage]
    gen_jsonl = arguments.gen_jsonl or os.path.join(BASE, JOB_ID, book, "proposition_generator.jsonl")
    reverify = bind_reverify(gen_jsonl, book, windows, input_hashes)
    out_dir = arguments.out_dir or os.path.join(BASE, JOB_ID, book, "reverify_8001")
    refuse_existing(out_dir)
    if arguments.dry_run:
        print(json.dumps({"dry_run": True, "acceptance_contract_version": 2,
                          "windows": len(windows), "cards": len(reverify[1]), **reverify[2]}, ensure_ascii=False))
        return 0
    return execute(arguments, book, windows, load_profile(os.environ.get("CANARY_GEN_PROFILE", "structured_source")),
                   verifier_profile, ("", ""), (ver_system, ver_user), input_hashes,
                   os.environ.get("CANARY_GEN_PROFILE", "structured_source"), reverify)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--book", required=True)
    parser.add_argument("--coverage-root", default=None)
    parser.add_argument("--roles", default="rule_atom_read")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--out-dir", default=None)
    parser.add_argument("--max-tokens", type=int, default=1500)
    parser.add_argument("--ver-max-tokens", type=int, default=16000)
    parser.add_argument("--dry-run", action="store_true", help="validate inputs and bindings offline")
    parser.add_argument("--overwrite", action="store_true", help="deprecated; existing directories are always refused")
    parser.add_argument("--gen-prompt", default=GEN_PROMPT)
    parser.add_argument("--ver-prompt", default=VER_PROMPT_CONTRACT)
    parser.add_argument("--job-id", default=JOB_ID)
    parser.add_argument("--verifier-only", action="store_true")
    parser.add_argument("--gen-jsonl", default=None)
    arguments = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if arguments.limit < 0 or arguments.max_tokens <= 0 or arguments.ver_max_tokens <= 0:
        raise SystemExit("FAIL: invalid limits")
    book = arguments.book
    out_dir = arguments.out_dir or os.path.join(BASE, JOB_ID, book,
                                               *(["reverify_8001"] if arguments.verifier_only else []))
    refuse_existing(out_dir)
    gen_name = os.environ.get("CANARY_GEN_PROFILE", "structured_source")
    profile, verifier_profile = load_profile(gen_name), load_profile("unstructured_analysis")
    if gen_name == "structured_source":
        if profile.get("thinking_disabled") is not True or profile.get("max_num_seqs") != 1:
            raise SystemExit("FAIL: structured_source requires thinking_disabled=true, max_num_seqs=1")
        if "localhost:8000/" not in profile["endpoint"] or arguments.max_tokens > profile["max_tokens"]:
            raise SystemExit("FAIL: generator endpoint or token budget")
    if "localhost:8001/" not in verifier_profile["endpoint"]:
        raise SystemExit("FAIL: verifier profile endpoint must be :8001 (unstructured_analysis)")
    if not arguments.dry_run and os.environ.get("DISABLE_LLM_THINKING") != "1":
        raise SystemExit("FAIL: DISABLE_LLM_THINKING=1 is required for dispatch")
    version_dir, sentences_rel = BOOKS.get(book, _WAVEA)
    coverage_root = arguments.coverage_root or (COVERAGE_ROOT if book in BOOKS else _WAVEA_COVERAGE_ROOT)
    book_root = os.path.join(REPO, "runs", book, version_dir)
    coverage_path = os.path.join(BASE, coverage_root, book, "coverage_partition.jsonl")
    sentences_path = os.path.join(book_root, sentences_rel)
    pointer = os.path.join(book_root, ".d01_sentences_path")
    if book not in BOOKS and os.path.exists(pointer):
        with open(pointer, encoding="utf-8") as handle:
            pointed = handle.read().strip()
        if pointed:
            sentences_path = pointed
    gen_rel, ver_rel = arguments.gen_prompt, arguments.ver_prompt
    gen_prompt = split_prompt(os.path.join(BASE, gen_rel))
    ver_prompt = split_prompt(os.path.join(BASE, ver_rel))
    try:
        coverage_hash, sentences_hash = sha256_file(coverage_path), sha256_file(sentences_path)
        coverage, sentences, windows = preflight_sources(
            read_jsonl(coverage_path), read_jsonl(sentences_path), book,
            {r.strip() for r in arguments.roles.split(",") if r.strip()}, arguments.limit)
        if coverage_hash != sha256_file(coverage_path) or sentences_hash != sha256_file(sentences_path):
            raise ValueError("source_changed_during_preflight")
        input_hashes = {
            "coverage_partition.jsonl": coverage_hash, "sentences.jsonl": sentences_hash,
            gen_rel: sha256_file(os.path.join(BASE, gen_rel)),
            ver_rel: sha256_file(os.path.join(BASE, ver_rel)),
            "source_proposition_audit_gates_v1.json": sha256_file(os.path.join(BASE, "source_proposition_audit_gates_v1.json")),
        }
        if arguments.verifier_only:
            return run_verifier_only(arguments, book, coverage, sentences, verifier_profile,
                                     *ver_prompt, ver_rel, input_hashes)
    except (ValueError, OSError, TypeError, KeyError) as error:
        raise SystemExit(f"FAIL: predispatch: {error}") from error
    if arguments.dry_run:
        print(json.dumps({"dry_run": True, "book": book, "acceptance_contract_version": 2,
                          "windows": len(windows), "windows_with_unresolved_sentence_ids": 0,
                          "out_dir": out_dir, "input_artifact_hashes": input_hashes,
                          "sample_window_block": windows[0]["sentences_block"][:400] if windows else ""},
                         ensure_ascii=False, indent=2))
        return 0
    return execute(arguments, book, windows, profile, verifier_profile, gen_prompt, ver_prompt,
                   input_hashes, gen_name)


if __name__ == "__main__":
    raise SystemExit(main())
