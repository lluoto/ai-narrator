"""Candidate-only v2 literal proposals; pure conversion, no runner integration.

Call normalize_payload(model_object_or_json, core.build_window(...)). Work/source
binding must already have passed core preflight/build_window. Literal provenance
does not establish semantic entailment. No I/O, dispatch, or runtime promotion.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from typing import Any

from tools import proposition_canary_run as core


CONTRACT_VERSION = "proposition_literal_evidence_v2"
SPAN_ALGORITHM = "exact_overlapping_literal_context_v1"
PROPOSAL_KEYS = tuple(
    "evidence_quotes" if key == "evidence_spans" else key for key in core.CARD_KEYS
)
QUOTE_KEYS = {"sentence_id", "source_slice", "source_context"}


class LiteralEvidenceError(ValueError):
    """Fail-closed contract error; no partially normalized batch is returned."""


def _occurrences(text: str, literal: str) -> list[int]:
    """Enumerate overlapping matches in the original Python Unicode string."""
    starts = []
    position = text.find(literal)
    while position != -1:
        starts.append(position)
        position = text.find(literal, position + 1)
    return starts


def _validated_window(window: Any) -> dict[str, Any]:
    # build_window drops work_id. Never invent or reconstitute a work binding here.
    if type(window) is not dict or set(window) != {
        "window_id", "chapter_id", "role", "sentence_ids", "sentences_block", "sentence_text"
    }:
        raise LiteralEvidenceError("invalid_validated_window_shape")
    ids, texts = window["sentence_ids"], window["sentence_text"]
    if (type(ids) is not list or not ids or any(type(sid) is not str for sid in ids)
            or type(texts) is not dict or set(texts) != set(ids)
            or any(type(text) is not str for text in texts.values())):
        raise LiteralEvidenceError("invalid_validated_window_sources")
    record = {"window_id": window["window_id"], "chapter_id": window["chapter_id"],
              "role": window["role"], "anchor_sentence_ids": ids, "attached_sentence_ids": []}
    sentences = {sid: {"sentence_id": sid, "chapter_id": window["chapter_id"], "text": texts[sid]}
                 for sid in ids}
    try:
        rebuilt = core.build_window(record, sentences)
    except (ValueError, TypeError) as error:
        raise LiteralEvidenceError("invalid_validated_window_binding") from error
    if rebuilt != window:
        raise LiteralEvidenceError("inconsistent_validated_window")
    return rebuilt


def normalize_payload(payload: Any, window: dict[str, Any]) -> dict[str, Any]:
    """Normalize a complete proposal batch or raise LiteralEvidenceError.

    Accept exactly {"propositions": [...]} as a JSON string or built-in dict.
    One quote per card, at most core.MAX_CARDS_PER_WINDOW cards. The caller must
    supply the original, already source/work-bound core window, not model text.
    Inputs are never changed; all returned mutable structures are independent.
    """
    window = _validated_window(window)
    if type(payload) is str:
        try:
            payload = core.strict_json(payload)
        except (ValueError, TypeError, RecursionError) as error:
            raise LiteralEvidenceError("invalid_payload_json") from error
    if type(payload) is not dict or set(payload) != {"propositions"}:
        raise LiteralEvidenceError("invalid_payload_shape")
    proposals = payload["propositions"]
    if type(proposals) is not list or len(proposals) > core.MAX_CARDS_PER_WINDOW:
        raise LiteralEvidenceError("invalid_propositions_list")

    cards, receipts = [], []
    for index, proposal in enumerate(proposals):
        if type(proposal) is not dict or set(proposal) != set(PROPOSAL_KEYS):
            raise LiteralEvidenceError(f"card[{index}]:invalid_proposal_shape")
        quotes = proposal["evidence_quotes"]
        if type(quotes) is not list or len(quotes) != 1:
            raise LiteralEvidenceError(f"card[{index}]:exactly_one_quote_required")
        quote = quotes[0]
        if type(quote) is not dict or set(quote) != QUOTE_KEYS:
            raise LiteralEvidenceError(f"card[{index}]:invalid_quote_shape")
        sid, literal, context = (quote[key] for key in ("sentence_id", "source_slice", "source_context"))
        if type(sid) is not str or sid not in window["sentence_text"]:
            raise LiteralEvidenceError(f"card[{index}]:sentence_not_supplied")
        ids = proposal["evidence_ids"]
        if type(ids) is not list or ids != [sid] or type(ids[0]) is not str:
            raise LiteralEvidenceError(f"card[{index}]:evidence_ids_must_equal_quote_sentence")
        if type(literal) is not str or not literal:
            raise LiteralEvidenceError(f"card[{index}]:nonempty_source_slice_required")
        if context is not None and (type(context) is not str or len(context) <= len(literal)):
            raise LiteralEvidenceError(f"card[{index}]:larger_literal_context_required")

        text = window["sentence_text"][sid]
        candidates = _occurrences(text, literal)
        if not candidates:
            raise LiteralEvidenceError(f"card[{index}]:source_slice_absent")
        if context is not None:
            relative = _occurrences(context, literal)
            if len(relative) != 1:
                raise LiteralEvidenceError(f"card[{index}]:context_must_contain_slice_once")
            enclosed = {start + relative[0] for start in _occurrences(text, context)}
            candidates = [start for start in candidates if start in enclosed]
        if len(candidates) != 1:
            raise LiteralEvidenceError(f"card[{index}]:quote_occurrence_not_unique")
        start = candidates[0]
        span = {"sentence_id": sid, "start": start, "end": start + len(literal)}
        card = {key: proposal[key] for key in core.CARD_KEYS if key != "evidence_spans"}
        card["evidence_spans"] = [span]
        normalized, errors = core.validate_card(card, window)
        if errors:
            raise LiteralEvidenceError(f"card[{index}]:core_card_invalid:" + ",".join(errors))
        # Canonical JSON hashes the original quote object, including explicit null.
        canonical_quote = json.dumps(quote, ensure_ascii=True, sort_keys=True,
                                     separators=(",", ":"), allow_nan=False).encode("ascii")
        try:
            source_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
        except UnicodeEncodeError as error:
            raise LiteralEvidenceError(f"card[{index}]:source_not_utf8_encodable") from error
        cards.append(deepcopy(normalized))
        receipts.append({
            "contract_version": CONTRACT_VERSION,
            "algorithm": SPAN_ALGORITHM,
            "proposition_index": index,
            "window_id": window["window_id"],
            "chapter_id": window["chapter_id"],
            "sentence_id": sid,
            "source_text_utf8_sha256": source_hash,
            "literal_context_canonical_sha256": hashlib.sha256(canonical_quote).hexdigest(),
            "evidence_quote": deepcopy(quote),
            "derived_span": deepcopy(span),
            "span_unit": "python_unicode_code_point",
            "span_interval": "half_open",
        })
    return {"contract_version": CONTRACT_VERSION, "candidate_only": True,
            "no_runtime_effect": True, "propositions": cards, "provenance": receipts}
