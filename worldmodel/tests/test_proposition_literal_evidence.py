"""Synthetic offline v2 contract tests; no model calls or runtime artifacts."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tools import proposition_literal_evidence as L

C = L.core
SID = "B001:C0001:S000001"
SID2 = "B001:C0001:S000002"
CHAPTER = "B001:C0001"
TEXT = "\u7532\U0001f600\u8bf4\uff1a\u201c\u95e8\u4e0d\u80fd\u5f00\u3002\u201d e\u0301"
NEGATIVE = "\u95e8\u4e0d\u80fd\u5f00"


def window(text=TEXT, attached=False):
    record = {"window_id": "literal-W1", "chapter_id": CHAPTER, "work_id": "synthetic-book",
              "role": "rule_atom_read", "anchor_sentence_ids": [SID],
              "attached_sentence_ids": [SID2] if attached else []}
    sources = {sid: {"sentence_id": sid, "chapter_id": CHAPTER, "work_id": "synthetic-book",
                     "text": text} for sid in (SID, SID2)}
    return C.build_window(record, sources)


def proposal(literal=NEGATIVE, context=None, sid=SID):
    return {"primary_route": "bounded_event", "proposition_text": NEGATIVE,
            "evidence_ids": [sid],
            "evidence_quotes": [{"sentence_id": sid, "source_slice": literal, "source_context": context}],
            "assertion_status": "direct_speech_claim", "temporal_status": "future_or_contingent",
            "evidence_directness": "explicit", "content_facets": ["bounded_event"],
            "generality_scope": "instance", "claimant_or_source": "\u7532\U0001f600"}


def payload(card=None):
    return {"propositions": [proposal() if card is None else card]}


class LiteralEvidenceTests(unittest.TestCase):
    def rejects(self, value, win=None, error=None):
        with self.assertRaises(L.LiteralEvidenceError) as caught:
            L.normalize_payload(value, window() if win is None else win)
        if error:
            self.assertIn(error, str(caught.exception))

    def test_cjk_astral_combining_codepoint_spans_and_legacy_card(self):
        result = L.normalize_payload(payload(), window())
        card = result["propositions"][0]
        self.assertEqual(set(card), set(C.CARD_KEYS))
        self.assertEqual(card["evidence_spans"], [{"sentence_id": SID, "start": 5, "end": 9}])
        self.assertEqual(C.render_evidence(card, window()), SID + "|" + NEGATIVE)
        self.assertEqual(C.validate_card(card, window()), (card, []))
        combined = L.normalize_payload(payload(proposal("e\u0301")), window())
        self.assertEqual(combined["propositions"][0]["evidence_spans"][0],
                         {"sentence_id": SID, "start": 12, "end": 14})
        emoji = L.normalize_payload(payload(proposal("\U0001f600")), window())
        self.assertEqual(emoji["propositions"][0]["evidence_spans"][0],
                         {"sentence_id": SID, "start": 1, "end": 2})

    def test_receipt_hash_definitions_and_safety_labels(self):
        original = payload()
        result = L.normalize_payload(original, window())
        receipt = result["provenance"][0]
        self.assertEqual(receipt["contract_version"], L.CONTRACT_VERSION)
        self.assertEqual(receipt["algorithm"], L.SPAN_ALGORITHM)
        self.assertEqual(receipt["source_text_utf8_sha256"], hashlib.sha256(TEXT.encode("utf-8")).hexdigest())
        quote = original["propositions"][0]["evidence_quotes"][0]
        canonical = json.dumps(quote, sort_keys=True, ensure_ascii=True, separators=(",", ":"), allow_nan=False)
        self.assertEqual(receipt["literal_context_canonical_sha256"],
                         hashlib.sha256(canonical.encode("ascii")).hexdigest())
        self.assertEqual(receipt["evidence_quote"], quote)
        self.assertEqual(receipt["derived_span"], result["propositions"][0]["evidence_spans"][0])
        self.assertEqual((receipt["window_id"], receipt["chapter_id"], receipt["sentence_id"]),
                         ("literal-W1", CHAPTER, SID))
        self.assertEqual((receipt["span_unit"], receipt["span_interval"]),
                         ("python_unicode_code_point", "half_open"))
        self.assertIs(result["candidate_only"], True)
        self.assertIs(result["no_runtime_effect"], True)
        self.assertNotIn("verified", json.dumps(result))
        self.assertNotIn("entailed", json.dumps(result))

    def test_negation_attribution_modality_preserved_without_semantic_certification(self):
        card = proposal(TEXT[:11])
        original = copy.deepcopy(card)
        result = L.normalize_payload(payload(card), window())
        for key in C.CARD_KEYS:
            if key != "evidence_spans":
                self.assertEqual(result["propositions"][0][key], original[key])
        # Structural provenance must not pretend to detect a semantically false claim.
        card["proposition_text"] = "The gate opened."
        self.assertEqual(L.normalize_payload(payload(card), window())["propositions"][0]["proposition_text"],
                         "The gate opened.")

    def test_overlapping_slice_requires_context_and_selects_second_occurrence(self):
        self.rejects(payload(proposal("aa")), window("aaa"), "not_unique")
        self.rejects(payload(proposal("aa", "aaa")), window("aaa"), "contain_slice_once")
        result = L.normalize_payload(payload(proposal("aa", "aab")), window("aaab"))
        self.assertEqual(result["propositions"][0]["evidence_spans"][0],
                         {"sentence_id": SID, "start": 1, "end": 3})
        self.assertEqual(result["provenance"][0]["evidence_quote"]["source_context"], "aab")

    def test_repeated_chinese_slice_context_selects_without_expanding_span(self):
        text = "\u4e1c\u95e8\u672a\u5f00\uff0c\u897f\u95e8\u672a\u5f00\u3002"
        literal = "\u95e8\u672a\u5f00"
        self.rejects(payload(proposal(literal)), window(text), "not_unique")
        result = L.normalize_payload(payload(proposal(literal, "\u897f" + literal)), window(text))
        span = result["propositions"][0]["evidence_spans"][0]
        self.assertEqual(span, {"sentence_id": SID, "start": 6, "end": 9})
        self.assertEqual(text[span["start"]:span["end"]], literal)

    def test_repeated_context_and_context_with_multiple_slices_fail(self):
        for text, literal, context in (("XaaXaa", "aa", "Xaa"),
                                       ("aaaa", "aa", "aaa"),
                                       ("XabYab", "ab", "XabYab")):
            with self.subTest(text=text, context=context):
                self.rejects(payload(proposal(literal, context)), window(text))

    def test_unique_slice_does_not_ignore_invalid_supplied_context(self):
        for context in ("missing ab", "other", "ab", "", [], 3, False, {}):
            with self.subTest(context=context):
                self.rejects(payload(proposal("ab", context)), window("XabY"))
        result = L.normalize_payload(payload(proposal("ab", "Xab")), window("XabY"))
        self.assertEqual(result["propositions"][0]["evidence_spans"][0]["start"], 1)
        self.rejects(payload(proposal("ab", "Xab")), window("abY"))

    def test_absent_empty_null_and_unknown_type_slices_fail(self):
        for literal in ("absent", "", None, 0, True, [], {}, float("nan")):
            with self.subTest(literal=literal):
                self.rejects(payload(proposal(literal)))
        card = proposal()
        del card["evidence_quotes"][0]["source_slice"]
        self.rejects(payload(card), error="quote_shape")

    def test_original_unicode_whitespace_punctuation_never_normalized(self):
        # Composed e-acute, ASCII colon, and stripped whitespace are not substitutes.
        cases = [("e\u0301", "\u00e9"), ("\uff21", "A"), ("\uff1a", ":"),
                 ("x y", "x  y"), ("\u4e0d\u80fd", "\u80fd\u4e86")]
        for text, literal in cases:
            with self.subTest(text=text, literal=literal):
                self.rejects(payload(proposal(literal)), window(text), "slice_absent")
        result = L.normalize_payload(payload(proposal(" ab ")), window(" ab "))
        self.assertEqual(result["propositions"][0]["evidence_spans"][0]["end"], 4)
        self.rejects(payload(proposal(" ab ")), window("ab"), "slice_absent")
        self.rejects(payload(proposal("ab", " Xab")), window("XabY"))

    def test_forged_unknown_or_wrong_sentence_ids_and_mismatched_citations(self):
        for sid in (SID2, "B002:C0001:S000001", "B001:C0002:S000001", None, [], 7):
            with self.subTest(sid=sid):
                self.rejects(payload(proposal(sid=sid)), error="sentence_not_supplied")
        for ids in ([], [SID2], [SID, SID2], [SID, SID], SID, [None], [True], {}):
            card = proposal()
            card["evidence_ids"] = ids
            with self.subTest(ids=ids):
                self.rejects(payload(card), window(attached=True))
        result = L.normalize_payload(payload(proposal(sid=SID2)), window(attached=True))
        self.assertEqual(result["propositions"][0]["evidence_ids"], [SID2])
        # A literal elsewhere in the supplied window cannot repair the pinned sentence.
        win = window(attached=True)
        win["sentence_text"][SID] = "different"
        win["sentences_block"] = SID + "|different\n" + SID2 + "|" + TEXT
        self.rejects(payload(), win, "slice_absent")

    def test_exactly_one_quote_no_model_offsets_and_exact_shapes(self):
        card = proposal()
        quote = card["evidence_quotes"][0]
        for quotes in ([], None, quote, [quote, quote], [None], ["literal"]):
            self.rejects(payload({**card, "evidence_quotes": quotes}))
        for key in ("start", "end", "evidence_spans", "occurrence", "unknown"):
            with self.subTest(key=key):
                self.rejects(payload({**card, key: 0}))
                self.rejects(payload({**card, "evidence_quotes": [{**quote, key: 0}]}))
        for key in L.QUOTE_KEYS:
            changed = copy.deepcopy(card)
            del changed["evidence_quotes"][0][key]
            self.rejects(payload(changed))
        for key in L.PROPOSAL_KEYS:
            changed = copy.deepcopy(card)
            del changed[key]
            self.rejects(payload(changed))

    def test_strict_parser_duplicate_keys_nonfinite_and_nonobject(self):
        invalid = ['{"propositions":[],"propositions":[]}',
                   '{"propositions":[],"x":NaN}', '{"propositions":Infinity}',
                   '{"propositions":-Infinity}', '{"propositions":1e999}',
                   '[]', 'null', 'true', '', '```json\n{}\n```', '{} trailing']
        encoded = json.dumps(payload())
        invalid.append(encoded.replace('"source_context": null', '"source_context":null,"source_context":null'))
        invalid.append(encoded.replace('"primary_route": "bounded_event"',
                                       '"primary_route":"bounded_event","primary_route":"bounded_event"'))
        for value in invalid:
            with self.subTest(value=value):
                self.rejects(value)
        for value in (None, [], 1, True, b'{"propositions":[]}', {},
                      {"propositions": None}, {"propositions": ()},
                      {"propositions": [], "extra": True}):
            with self.subTest(value=value):
                self.rejects(value)

    def test_core_semantic_validation_still_applies(self):
        for changes in ({"primary_route": "attribution_only"}, {"primary_route": []},
                        {"assertion_status": "verified"}, {"temporal_status": None},
                        {"evidence_directness": True}, {"generality_scope": "global"},
                        {"proposition_text": " "}, {"proposition_text": float("nan")},
                        {"content_facets": ["bounded_event", "bounded_event"]},
                        {"content_facets": [object()]}, {"claimant_or_source": {}},
                        {"claimant_or_source": float("inf")}):
            with self.subTest(changes=changes):
                self.rejects(payload({**proposal(), **changes}), error="core_card_invalid")
        card = {**proposal(), "primary_route": "attributed_context",
                "content_facets": ["attributed_context"], "claimant_or_source": None}
        self.assertEqual(L.normalize_payload(payload(card), window())["propositions"][0]["primary_route"],
                         "attributed_context")
        with mock.patch.object(C, "validate_card", wraps=C.validate_card) as validator:
            L.normalize_payload(payload(), window())
        self.assertEqual(validator.call_count, 1)

    def test_empty_propositions_maximum_three_and_batch_failure_is_atomic(self):
        result = L.normalize_payload('{"propositions":[]}', window())
        self.assertEqual(result["propositions"], [])
        self.assertEqual(result["provenance"], [])
        three = {"propositions": [proposal() for _ in range(3)]}
        self.assertEqual([r["proposition_index"] for r in L.normalize_payload(three, window())["provenance"]],
                         [0, 1, 2])
        self.rejects({"propositions": [proposal() for _ in range(4)]})
        original = {"propositions": [proposal(), proposal("absent")]}
        before = copy.deepcopy(original)
        self.rejects(original, error="card[1]")
        self.assertEqual(original, before)

    def test_determinism_key_order_json_equivalence_and_deepcopy_independence(self):
        original, win = payload(), window()
        before, win_before = copy.deepcopy(original), copy.deepcopy(win)
        first = L.normalize_payload(original, win)
        second = L.normalize_payload(json.dumps(original, ensure_ascii=True), win)
        reversed_card = dict(reversed(list(original["propositions"][0].items())))
        reversed_card["evidence_quotes"] = [dict(reversed(list(reversed_card["evidence_quotes"][0].items())))]
        self.assertEqual(first, second)
        self.assertEqual(first, L.normalize_payload(payload(reversed_card), win))
        self.assertEqual((original, win), (before, win_before))
        first["propositions"][0]["evidence_ids"].append("changed")
        first["propositions"][0]["content_facets"].append("changed")
        first["propositions"][0]["evidence_spans"][0]["start"] = 99
        first["provenance"][0]["evidence_quote"]["source_slice"] = "changed"
        self.assertEqual((original, win), (before, win_before))
        self.assertEqual(first["provenance"][0]["derived_span"]["start"], 5)
        original["propositions"][0]["evidence_quotes"][0]["source_slice"] = "later"
        self.assertEqual(second["provenance"][0]["evidence_quote"]["source_slice"], NEGATIVE)
        self.assertEqual(second, L.normalize_payload(before, win_before))

    def test_validated_window_binding_and_upstream_work_check(self):
        for changes in ({"chapter_id": "B002:C0001"}, {"sentence_ids": [SID, SID]},
                        {"sentence_ids": [SID2]}, {"sentences_block": "forged"},
                        {"sentence_text": {SID: TEXT, SID2: TEXT}},
                        {"sentence_text": {SID: None}}, {"sentence_ids": [None]},
                        {"window_id": ""}, {"work_id": "forged"}):
            with self.subTest(changes=changes):
                self.rejects(payload(), {**window(), **changes})
        for value in (None, [], {}):
            with self.assertRaises(L.LiteralEvidenceError):
                L.normalize_payload(payload(), value)
        record = {"window_id": "W", "chapter_id": CHAPTER, "work_id": "A", "anchor_sentence_ids": [SID]}
        source = {"sentence_id": SID, "chapter_id": CHAPTER, "work_id": "B", "text": TEXT}
        with self.assertRaisesRegex(ValueError, "source_work_mismatch"):
            C.build_window(record, {SID: source})
        self.assertNotIn("work_id", window())

    def test_ill_formed_unicode_fails_with_contract_error(self):
        self.rejects(payload(proposal("ab")), window("ab\ud800"), "utf8")

    def test_prompt_enums_examples_and_placeholders_match_contract(self):
        path = (Path(C.BASE) / "proposition_canary_prompts" /
                "proposition_generator_prompt_v2_literal_evidence.txt")
        system, user = C.split_prompt(str(path))
        for vocabulary in (C.PRIMARY_ROUTES, C.ASSERTION_STATUS, C.TEMPORAL_STATUS,
                           C.EVIDENCE_DIRECTNESS, C.GENERALITY_SCOPE):
            for token in vocabulary:
                self.assertIn(token, system)
        self.assertIn(L.CONTRACT_VERSION, system)
        self.assertIn("EXACTLY ONE", system)
        self.assertIn("AT MOST 3", system)
        self.assertIn("ONLY when the", system)
        self.assertIn("attribution act itself", system)
        self.assertNotIn("\x01", system)
        for key in ("work_id", "window_id", "chapter_id", "sentences_block"):
            self.assertIn("{" + key + "}", user)
        example = next(line for line in system.splitlines() if line.startswith('{"propositions":[{"primary_route"'))
        sid = "B999:C0001:S000001"
        text = "\u7532\U0001f600\u8bf4\uff1a\u201c\u95e8\u6ca1\u6709\u5f00\u3002\u201d"
        win = C.build_window({"window_id": "example", "chapter_id": "B999:C0001",
                              "anchor_sentence_ids": [sid]},
                             {sid: {"sentence_id": sid, "chapter_id": "B999:C0001", "text": text}})
        result = L.normalize_payload(example, win)
        self.assertEqual(result["propositions"][0]["evidence_spans"][0]["end"], 11)


if __name__ == "__main__":
    unittest.main()
