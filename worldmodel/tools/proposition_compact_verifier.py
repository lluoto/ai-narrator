"""Pure offline compact experiment; never selected by the production runner.

This validates content, not transport, source identity, or semantic truth. Before
calling, the caller must bind durable raw request/response captures to the same
trusted call/case/work/source snapshot and validate the HTTP/model/choice/finish
envelope. The supplied window must already have passed core source preflight;
the normalized card's exact spans must match the manifest actually sent. Reused
sentence IDs cannot establish work or request identity. Retain raw thought at the
caller; neither adapter returns it. Attach any identity/hash envelope only after
independent caller binding. Boundary flags express this module's review policy,
not evidence that those external gates passed. No I/O or dispatch occurs here.
"""
from __future__ import annotations

import json
import math

from . import proposition_canary_run as core


CONTRACT_VERSION = "proposition_verifier_compact_experiment_v1"
REQUIRED_FIELDS = core.REQUIRED_VERIFIER_FIELDS
REASON_MATRIX = (
    ("entailed", "semantic_support"),
    ("entailed", "narrator_null_supported"),
    ("insufficient_evidence", "missing_support"),
    ("insufficient_evidence", "ambiguous_support"),
    ("insufficient_evidence", "unresolved_claimant"),
    ("contradicted", "source_conflict"),
    ("abstain", "policy_undecidable"),
)
CLAIMANT_CODES = ("narrator_null_supported", "unresolved_claimant")
ANSWER_FORMATS = ("strict_json", "qwen_final_block")
MAX_CONTENT_CHARS = 65536
MAX_JSON_DEPTH = 16


class CompactVerifierError(ValueError):
    """Fixed local error codes only; never include source or response prose."""


def build_model_output_schema():
    """Return a fresh model-visible schema; card-dependent guards are additional."""
    codes = [code for _, code in REASON_MATRIX]
    ordinary_codes = [code for code in codes if code not in CLAIMANT_CODES]
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "additionalProperties": False,
        "required": list(REQUIRED_FIELDS),
        "properties": {
            field: ({"$ref": "#/$defs/check"} if field == "claimant_or_source" else {
                "$ref": "#/$defs/check",
                "properties": {"reason_code": {"enum": list(ordinary_codes)}},
            }) for field in REQUIRED_FIELDS
        },
        "$defs": {"check": {
            "type": "object",
            "additionalProperties": False,
            "required": ["verdict", "evidence_ids", "reason_code"],
            "properties": {
                "verdict": {"enum": list(core.CONTRACT_OVERALL)},
                "evidence_ids": {"type": "array", "minItems": 1, "uniqueItems": True,
                                 "items": {"type": "string", "minLength": 1}},
                "reason_code": {"enum": codes},
            },
            "oneOf": [{"properties": {"verdict": {"const": verdict},
                                       "reason_code": {"const": code}}}
                      for verdict, code in REASON_MATRIX],
        }},
    }


def _public_answer(content, answer_format):
    if answer_format not in ANSWER_FORMATS:
        raise CompactVerifierError("answer_format:unsupported")
    if not isinstance(content, str) or not content.strip(" \t\r\n"):
        raise CompactVerifierError("content:empty_or_not_string")
    if len(content) > MAX_CONTENT_CHARS:
        raise CompactVerifierError("content:too_large")
    try:
        content.encode("utf-8", errors="strict")
    except UnicodeError:
        raise CompactVerifierError("content:invalid_unicode") from None
    if answer_format == "strict_json":
        return content
    text = content.strip(" \t\r\n")
    # Anchored grammar, including Qwen's implicit opening think marker. Never
    # search for a convenient JSON object in the thought or a malformed tail.
    if text.count("<VERDICT_JSON>") != 1 or text.count("</VERDICT_JSON>") != 1:
        raise CompactVerifierError("answer:verdict_block_count")
    if "</think>" in text:
        if text.count("</think>") != 1 or text.count("<think>") > 1:
            raise CompactVerifierError("answer:think_wrapper")
        thought, _, text = text.partition("</think>")
        if "<think>" in thought and not thought.startswith("<think>"):
            raise CompactVerifierError("answer:think_wrapper")
        if "<VERDICT_JSON>" in thought or "</VERDICT_JSON>" in thought:
            raise CompactVerifierError("answer:think_wrapper")
        text = text.strip(" \t\r\n")
    if "<think>" in text or "</think>" in text:
        raise CompactVerifierError("answer:think_wrapper")
    if not text.startswith("<VERDICT_JSON>") or not text.endswith("</VERDICT_JSON>"):
        raise CompactVerifierError("answer:verdict_block_shape")
    return text[len("<VERDICT_JSON>"):-len("</VERDICT_JSON>")]


def _decode(answer):
    # Bound nesting before decoding, ignoring brackets inside JSON strings.
    depth, quoted, escaped = 0, False, False
    for char in answer:
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char in "[{":
            depth += 1
            if depth > MAX_JSON_DEPTH:
                raise CompactVerifierError("json:too_deep")
        elif char in "]}":
            depth -= 1

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise CompactVerifierError("json:duplicate_key")
            result[key] = value
        return result

    def constant(_):
        raise CompactVerifierError("json:nonfinite_number")

    def finite_float(value):
        number = float(value)
        if not math.isfinite(number):
            raise CompactVerifierError("json:nonfinite_number")
        return number

    try:
        return json.loads(answer, object_pairs_hook=pairs, parse_constant=constant,
                          parse_float=finite_float)
    except CompactVerifierError:
        raise
    except (ValueError, RecursionError):
        raise CompactVerifierError("json:malformed") from None


def parse_compact(content, card, window, *, contract_version, answer_format):
    """Return fresh model_checks, derived overall and four review boundary flags.

    Both dispatch selectors are required trusted caller inputs, never inferred
    from output. strict_json consumes one JSON object; qwen_final_block consumes
    exactly one <VERDICT_JSON> object block, optionally following one closed
    <think>...</think> or implicit-opening thought ending in </think>. Only JSON
    whitespace may surround the public answer. No repair or truncation salvage.

    Raises CompactVerifierError on failure, with no partial result or overall.
    This API deliberately accepts no case/hash envelope and claims no association
    validation. The caller owns the preconditions in the module docstring.
    """
    if contract_version != CONTRACT_VERSION:
        raise CompactVerifierError("contract_version:mismatch")
    normalized, card_errors = core.validate_card(card, window)
    if card_errors or normalized != card:
        # Core's unknown-key error can contain an arbitrary input key.
        error = card_errors[0] if card_errors else "not_normalized"
        if error.startswith("unknown_key:"):
            error = "unknown_key"
        raise CompactVerifierError("card:" + error)
    payload = _decode(_public_answer(content, answer_format))
    if not isinstance(payload, dict):
        raise CompactVerifierError("fields:not_object")
    for field in REQUIRED_FIELDS:
        if field not in payload:
            raise CompactVerifierError(field + ":missing")
    if set(payload) != set(REQUIRED_FIELDS):
        raise CompactVerifierError("fields:unknown")
    checks = {}
    allowed_ids = set(normalized["evidence_ids"])
    for field in REQUIRED_FIELDS:
        check = payload[field]
        if not isinstance(check, dict) or set(check) != {"verdict", "evidence_ids", "reason_code"}:
            raise CompactVerifierError(field + ":check_shape")
        verdict, code, ids = check["verdict"], check["reason_code"], check["evidence_ids"]
        if not isinstance(verdict, str) or verdict not in core.CONTRACT_OVERALL:
            raise CompactVerifierError(field + ":verdict")
        if not isinstance(code, str) or code not in tuple(c for _, c in REASON_MATRIX):
            raise CompactVerifierError(field + ":reason_code")
        if (verdict, code) not in REASON_MATRIX:
            raise CompactVerifierError(field + ":verdict_reason_pair")
        if code in CLAIMANT_CODES and field != "claimant_or_source":
            raise CompactVerifierError(field + ":claimant_only_code")
        if (not isinstance(ids, list) or not ids
                or any(not isinstance(sid, str) or not sid for sid in ids)):
            raise CompactVerifierError(field + ":evidence_ids")
        if len(ids) != len(set(ids)):
            raise CompactVerifierError(field + ":duplicate_citation")
        if not set(ids) <= allowed_ids:
            raise CompactVerifierError(field + ":citation_outside_sent_card")
        checks[field] = {"verdict": verdict, "evidence_ids": list(ids), "reason_code": code}
    claimant = checks["claimant_or_source"]
    null = normalized["claimant_or_source"] is None
    narrator = normalized["assertion_status"] == "narrator_asserted"
    if claimant["reason_code"] == "narrator_null_supported" and not (
            null and narrator and checks["assertion_status"]["verdict"] == "entailed"):
        raise CompactVerifierError("claimant_or_source:narrator_null_guard")
    if claimant["reason_code"] == "unresolved_claimant" and not (null and not narrator):
        raise CompactVerifierError("claimant_or_source:unresolved_claimant_guard")
    if null and not narrator and claimant["reason_code"] != "unresolved_claimant":
        raise CompactVerifierError("claimant_or_source:unresolved_claimant_required")
    if null and narrator and claimant["verdict"] == "entailed" and (
            claimant["reason_code"] != "narrator_null_supported"):
        raise CompactVerifierError("claimant_or_source:narrator_null_code_required")
    overall = next(verdict for verdict in core.VERDICT_PRECEDENCE
                   if any(check["verdict"] == verdict for check in checks.values()))
    return {"model_checks": checks, "overall": overall,
            "no_runtime_effect": True, "review_only": True, "quality_certified": False,
            "automatic_promotion_permitted": False}
