"""Offline compiler regressions. Every generation/source/package is a fixture."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock


ROOT = Path(__file__).absolute().parents[1]
PATH = ROOT / "tools/prepare_card_reverify.py"
SPEC = importlib.util.spec_from_file_location("card_reverify_preparation_test", PATH)
P = importlib.util.module_from_spec(SPEC)
exec(compile(PATH.read_bytes(), str(PATH), "exec"), P.__dict__)
WORK = "fixture-book"
SID = "B001:C0001:S000001"
SID2 = "B001:C0001:S000002"
CHAPTER = "B001:C0001"
MODEL = "fixture-model"
SECRET = "GENERATOR_PRIVATE_RATIONALE_DO_NOT_COPY"


def ref(path):
    return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def write_json(path, value):
    path.write_bytes(P.canonical_bytes(value) + b"\n")


def write_rows(path, rows):
    path.write_bytes(b"".join(P.canonical_bytes(row) + b"\n" for row in rows))


def read_rows(path):
    return [json.loads(line) for line in path.read_bytes().split(b"\n") if line.strip()]


class PreparationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.attempt = self.root / "original"
        self.attempt.mkdir()
        self.gen = self.attempt / "proposition_generator.jsonl"
        self.job = self.attempt / "job_record.json"
        self.coverage = self.root / "coverage.jsonl"
        self.sentences = self.root / "sentences.jsonl"
        self.prompt = self.root / "canonical-copy.txt"
        self.prompt.write_bytes(P.CANONICAL_PROMPT.read_bytes())
        self.config = self.root / "worker_config.json"
        write_json(self.config, {"chat_api_key_env": "NOT_TO_COPY", "profiles": {
            "unstructured_analysis": {"endpoint": "http://localhost:8001/v1/chat/completions",
                "api_key_env": "NEVER_COPY_AUTH", "headers": {"Authorization": "NEVER_COPY_SECRET"},
                "model": MODEL, "thinking_disabled": False, "max_tokens": None,
                "max_model_len": 32768, "max_num_seqs": 1}}})
        self.selection = self.root / "decision.json"
        self.out = self.root / "package"
        self.card = {"primary_route": "bounded_event", "proposition_text": "The gate opens.",
            "evidence_ids": [SID], "evidence_spans": [{"sentence_id": SID, "start": 0, "end": 15}],
            "assertion_status": "narrator_asserted", "temporal_status": "bounded_occurrence",
            "evidence_directness": "explicit", "content_facets": ["bounded_event"],
            "generality_scope": "instance", "claimant_or_source": None}
        self.coverage_rows = [{"work_id": WORK, "window_id": wid, "chapter_id": CHAPTER,
            "anchor_sentence_ids": [SID, SID2], "attached_sentence_ids": [], "role": "rule_atom_read"}
            for wid in ("W1", "W2")]
        self.sentence_rows = [{"work_id": WORK, "chapter_id": CHAPTER, "sentence_id": sid, "text": text}
            for sid, text in ((SID, "The gate opens. Not supplied to the verifier."),
                              (SID2, "This unrelated sentence must never reach verifier messages."))]
        self.item = self.make_item("W1", 0)
        rejected = self.make_item("W1", 1)
        rejected["generator_card"]["evidence_spans"][0]["end"] = 10000
        rejected.update(normalized_card=None, accepted_for_verification=False,
                        schema_errors=["span_out_of_bounds", "evidence_ids_span_mismatch"], route=None)
        self.rows = [self.make_row("W1", [self.item, rejected]),
                     self.make_row("W2", [self.make_item("W2", 0)])]
        self.job_data = {"book": WORK, "model": MODEL, "ok": False, "status": "failed",
                         "verification_complete": False, "acceptance_contract_version": 2,
                         "generator_reused": False}
        self.selected = [{"card_id": "W1#0", "candidate_sha256": P.candidate_sha256(self.card)}]
        self.extra_sources = []
        self.refresh()
        for target, attribute in ((P.C, "call_model"), (P.C.urllib.request.OpenerDirector, "open")):
            patch = mock.patch.object(target, attribute, side_effect=AssertionError("network forbidden"))
            patch.start()
            self.addCleanup(patch.stop)

    def make_item(self, wid, position):
        return {"card_id": f"{wid}#{position}", "work_id": WORK, "allowed_work_ids": [WORK],
                "window_id": wid, "chapter_id": CHAPTER, "route": "bounded_event",
                "accepted_for_verification": True, "schema_errors": [],
                "generator_card": copy.deepcopy(self.card), "normalized_card": copy.deepcopy(self.card),
                "rationale": SECRET}

    def make_row(self, wid, items):
        raw = json.dumps({"propositions": [item["generator_card"] for item in items]})
        return {"window_id": wid, "work_id": WORK, "allowed_work_ids": [WORK], "chapter_id": CHAPTER,
                "sentence_ids": [SID, SID2], "cards": items, "proposed_count": len(items),
                "model_parse_ok": True, "parse_error": None, "raw_response": raw, "rationale": SECRET,
                "call_meta": {"http_status": 200, "model": MODEL, "finish_reason": "stop", "error": None,
                              "content_sha256": P.C.sha256_text(raw)}}

    def refresh(self, *, seal=True, bind=True, store_rows=True):
        write_rows(self.coverage, self.coverage_rows)
        write_rows(self.sentences, self.sentence_rows)
        if store_rows:
            write_rows(self.gen, self.rows)
        if bind:
            self.job_data["input_artifact_hashes"] = {
                "coverage_partition.jsonl": ref(self.coverage)["sha256"],
                "sentences.jsonl": ref(self.sentences)["sha256"]}
        if seal:
            self.job_data["output_file_hashes"] = {self.gen.name: ref(self.gen)["sha256"]}
        write_json(self.job, self.job_data)
        self.source = {"work_id": WORK, "generator": ref(self.gen), "generator_job": ref(self.job),
                       "coverage": ref(self.coverage), "sentences": ref(self.sentences),
                       "selected_cards": copy.deepcopy(self.selected)}
        self.decision = {"schema_version": 1, "verifier_prompt": ref(self.prompt),
                         "worker_config": ref(self.config), "sources": [self.source] + self.extra_sources}
        self.pin = self.save_decision()

    def save_decision(self):
        write_json(self.selection, self.decision)
        return ref(self.selection)["sha256"]

    def prepare(self, materialize=False):
        return P.prepare(self.selection, self.pin, self.out, materialize=materialize)

    def assert_rejected(self, reason=None):
        with self.assertRaises((ValueError, OSError, TypeError)) as caught:
            self.prepare(materialize=True)
        if reason is not None:
            self.assertIn(reason, str(caught.exception))
        self.assertFalse(self.out.exists())

    def test_imperfect_generation_preserves_rejected_sibling_and_full_refs(self):
        result = self.prepare(materialize=True)
        report = result["report"]
        self.assertEqual(report["counts"], {"verifier_inputs": 1, "rejected_cards": 1,
                         "unselected_cards": 1, "generation_issues": 0})
        self.assertEqual(report["inventoried_cards"], 3)
        self.assertEqual(report["per_work_counts"], [{"work_id": WORK, "counts": report["counts"],
                                                    "inventoried_cards": 3}])
        self.assertTrue(report["accounting_balanced"])
        selected = read_rows(self.out / "verifier_inputs.jsonl")[0]
        rejected = read_rows(self.out / "rejected_cards.jsonl")[0]
        unselected = read_rows(self.out / "unselected_cards.jsonl")[0]
        self.assertEqual(selected["evidence_block"], f"{SID}|The gate opens.")
        self.assertEqual(selected["case_id"], f"{WORK}|W1|W1#0")
        for key in P.ARTIFACTS:
            self.assertEqual(selected[key], self.source[key])
            self.assertEqual(rejected[key], self.source[key])
        self.assertEqual(rejected["card_id"], "W1#1")
        self.assertIn("span_out_of_bounds", rejected["observed_error_codes"])
        self.assertEqual(rejected["original_error_codes"], self.rows[0]["cards"][1]["schema_errors"])
        self.assertEqual(unselected["card_id"], "W2#0")
        self.assertEqual(unselected["schema_span_status"], "valid")
        self.assertEqual(len(report["per_work_route"]), 3)
        self.assertTrue(all(row["route"] == "bounded_event" for row in report["per_work_route"]))
        for artifact in (report, selected, rejected, unselected):
            self.assertFalse(artifact["dispatch_authorized"])
            self.assertFalse(artifact["whole_generation_certified"])
            self.assertEqual(artifact["input_status"], "UNVERIFIED_verifier_INPUT")
            self.assertNotIn("verdict", artifact)
        self.assertEqual(P.verify_package(self.out, result["package_manifest_sha256"])["counts"], report["counts"])

    def test_exact_canonical_messages_and_whitelisted_request_plan(self):
        self.prepare(materialize=True)
        selected = read_rows(self.out / "verifier_inputs.jsonl")[0]
        system, template = P.C.split_prompt(str(P.CANONICAL_PROMPT))
        canonical_card = json.loads(P.canonical_bytes(self.card))
        expected = P.C.render(template, {"case_id": f"{WORK}|W1|W1#0", "work_id": WORK,
                    "evidence_block": f"{SID}|The gate opens.",
                    "candidate_json": json.dumps({key: canonical_card[key] for key in P.C.CARD_KEYS}, ensure_ascii=False)})
        self.assertEqual(selected["messages"], [{"role": "system", "content": system},
                                              {"role": "user", "content": expected}])
        messages = json.dumps(selected["messages"])
        for forbidden in (SECRET, "Not supplied", SID2, "raw_response"):
            self.assertNotIn(forbidden, messages)
        self.assertNotIn('"rationale":', selected["messages"][1]["content"])
        for path in self.out.iterdir():
            content = path.read_text()
            for forbidden in (SECRET, "NEVER_COPY", "http://", "Authorization", "api_key_env", "endpoint"):
                self.assertNotIn(forbidden, content)
        self.assertNotIn("The gate opens", (self.out / "rejected_cards.jsonl").read_text())
        plan = selected["request_plan"]
        self.assertEqual(plan["max_tokens"], 16000)
        self.assertFalse(plan["thinking_disabled"])
        self.assertEqual(plan["model"], MODEL)
        self.assertEqual(plan["completion_requests_per_input"], 1)
        self.assertTrue(plan["serial"])
        self.assertEqual(plan["automatic_retries"], 0)

    def test_literal_unicode_separators_preserve_jsonl_source_spans_and_evidence(self):
        original_spans = copy.deepcopy(self.card["evidence_spans"])
        baseline_outputs, _, _ = P.compile_package(self.selection, self.pin)
        baseline = json.loads(baseline_outputs["verifier_inputs.jsonl"])
        for newline in (b"\n", b"\r\n"):
            for inside_support in (False, True):
                with self.subTest(newline=newline, inside_support=inside_support):
                    support = "The\u2028gate\u2029opens\u0085" if inside_support else "The gate opens."
                    self.sentence_rows[0]["text"] = support + " Outside support:\u2028paragraph\u2029next\u0085tail"
                    data = newline.join(json.dumps(row, ensure_ascii=False).encode("utf-8")
                                        for row in self.sentence_rows) + newline
                    self.sentences.write_bytes(data)
                    for separator in ("\u2028", "\u2029", "\u0085"):
                        self.assertIn(separator.encode("utf-8"), data)
                        self.assertNotIn(json.dumps(separator).encode("ascii")[1:-1], data)
                    self.assertEqual(data.count(b"\n"), len(self.sentence_rows))
                    self.assertEqual(data.count(b"\r\n"), len(self.sentence_rows) if newline == b"\r\n" else 0)
                    self.assertEqual(P.C.read_jsonl(str(self.sentences)), self.sentence_rows)
                    self.job_data["input_artifact_hashes"]["sentences.jsonl"] = ref(self.sentences)["sha256"]
                    write_json(self.job, self.job_data)
                    self.source["sentences"] = ref(self.sentences)
                    self.source["generator_job"] = ref(self.job)
                    self.pin = self.save_decision()
                    self.out = self.root / ("unicode-" + str(len(newline)) + "-" + str(inside_support))
                    result = self.prepare(materialize=True)
                    selected = read_rows(self.out / "verifier_inputs.jsonl")[0]
                    self.assertEqual(selected["normalized_card"]["evidence_spans"], original_spans)
                    self.assertEqual(self.sentence_rows[0]["text"][0:15], support)
                    expected = (SID + "|" + support).encode("utf-8")
                    self.assertEqual(selected["evidence_block"].encode("utf-8"), expected)
                    self.assertEqual(selected["evidence_sha256"], hashlib.sha256(expected).hexdigest())
                    self.assertEqual(selected["sentences"], ref(self.sentences))
                    if not inside_support:
                        self.assertEqual(selected["evidence_sha256"], baseline["evidence_sha256"])
                        self.assertEqual(selected["messages"], baseline["messages"])
                    self.assertTrue(P.verify_package(self.out, result["package_manifest_sha256"])["package_verified"])
                    self.assertEqual(self.sentences.read_bytes(), data)

    def test_legacy_historical_ok_is_unverified_input(self):
        self.job_data.pop("acceptance_contract_version")
        self.job_data.pop("output_file_hashes")
        self.job_data["ok"] = True
        self.refresh(seal=False)
        result = self.prepare(materialize=True)
        snapshot = result["report"]["snapshots"][0]
        self.assertFalse(snapshot["strict_v2_provenance_validated"])
        self.assertIn("strict_v2_provenance_missing", snapshot["provenance_warnings"])
        self.assertIn("raw_captures_missing_or_unpinned", snapshot["provenance_warnings"])
        self.assertIn("output_manifest_missing", snapshot["provenance_warnings"])
        self.assertFalse(result["whole_generation_certified"])

    def test_selected_call_envelopes_fail_closed(self):
        baseline = copy.deepcopy(self.rows)
        variants = ({"http_status": 503}, {"http_status": 200.0}, {"model": "wrong"},
                    {"finish_reason": "length"}, {"error": ""}, {"error": False},
                    {"response_incomplete": True}, {"content_sha256": "0" * 64}, "missing_error", "missing_meta")
        for variant in variants:
            with self.subTest(variant=variant):
                self.rows = copy.deepcopy(baseline)
                if variant == "missing_error":
                    del self.rows[0]["call_meta"]["error"]
                elif variant == "missing_meta":
                    del self.rows[0]["call_meta"]
                else:
                    self.rows[0]["call_meta"].update(variant)
                self.refresh()
                self.assert_rejected("selected_generator_invalid")

    def test_selected_raw_parse_counts_order_and_correspondence_fail_closed(self):
        baseline = copy.deepcopy(self.rows)
        variants = ({"model_parse_ok": False}, {"model_parse_ok": 1}, {"parse_error": "bad"},
            {"proposed_count": True}, {"proposed_count": 1}, {"raw_response": "not json"},
            {"raw_response": '{"propositions":[],"propositions":[]}'},
            {"raw_response": '{"propositions":[NaN]}'},
            {"raw_response": json.dumps({"propositions": [self.card] * 4})},
            {"raw_response": json.dumps({"propositions": [self.card], "extra": True})},
            {"raw_response": json.dumps({"propositions": [self.card, self.card]})},
            "missing_parse_error", "missing_parse_ok", "missing_raw", "reverse", "id")
        for variant in variants:
            with self.subTest(variant=variant):
                self.rows = copy.deepcopy(baseline)
                row = self.rows[0]
                if variant == "reverse":
                    row["cards"].reverse()
                elif variant == "id":
                    row["cards"][1]["card_id"] = "arbitrary"
                elif isinstance(variant, str):
                    del row[{"missing_parse_error": "parse_error", "missing_parse_ok": "model_parse_ok",
                             "missing_raw": "raw_response"}[variant]]
                else:
                    row.update(variant)
                if "raw_response" in row:
                    row["call_meta"]["content_sha256"] = P.C.sha256_text(row["raw_response"])
                self.refresh()
                self.assert_rejected("selected_generator_invalid")

    def test_selected_invalid_card_never_falls_back(self):
        baseline = copy.deepcopy(self.rows)
        for variant in ("rejected", "span", "normalized", "bool_offset", "float_offset", "route",
                        "schema_errors", "missing_schema_errors", "accepted", "chapter", "window", "candidate_hash"):
            with self.subTest(variant=variant):
                self.rows = copy.deepcopy(baseline)
                self.selected = [{"card_id": "W1#0", "candidate_sha256": P.candidate_sha256(self.card)}]
                card = self.rows[0]["cards"][0]
                if variant == "rejected":
                    self.selected[0]["card_id"] = "W1#1"
                elif variant == "span":
                    card["generator_card"]["evidence_spans"][0]["end"] = 99999
                    self.rows[0] = self.make_row("W1", self.rows[0]["cards"])
                elif variant == "normalized":
                    card["normalized_card"]["proposition_text"] = "Another claim"
                elif variant in ("bool_offset", "float_offset"):
                    card["normalized_card"]["evidence_spans"][0]["start"] = False if variant == "bool_offset" else 0.0
                elif variant == "route":
                    card["route"] = "mechanism"
                elif variant == "schema_errors":
                    card["schema_errors"] = ["inherited_error"]
                elif variant == "missing_schema_errors":
                    del card["schema_errors"]
                elif variant == "accepted":
                    card["accepted_for_verification"] = False
                elif variant == "chapter":
                    card["chapter_id"] = "B002:C0001"
                elif variant == "window":
                    card["window_id"] = "W2"
                else:
                    self.selected[0]["candidate_sha256"] = "0" * 64
                self.refresh()
                self.assert_rejected()

    def test_selected_window_requires_original_chapter_and_sentence_order(self):
        baseline = copy.deepcopy(self.rows)
        for change in ({"chapter_id": "B002:C0001"}, {"sentence_ids": [SID]},
                       {"sentence_ids": [SID2, SID]}):
            self.rows = copy.deepcopy(baseline)
            self.rows[0].update(change)
            self.refresh()
            self.assert_rejected("generator_row_source_binding_mismatch")

    def test_unselected_bad_calls_and_zero_card_windows_are_inventoried(self):
        self.rows[1]["call_meta"]["finish_reason"] = "length"
        self.rows[1]["raw_response"] = SECRET
        self.rows[1]["model_parse_ok"] = False
        self.rows.append({"work_id": WORK, "allowed_work_ids": [WORK], "window_id": "W3",
                          "chapter_id": CHAPTER, "cards": [], "model_parse_ok": False,
                          "parse_error": "failed", "raw_response": SECRET})
        self.refresh()
        result = self.prepare(materialize=True)
        issues = read_rows(self.out / "generation_issues.jsonl")
        self.assertEqual({row["window_id"] for row in issues}, {"W2", "W3"})
        self.assertTrue(all(row["error_codes"] for row in issues))
        self.assertEqual(issues[1]["observed_card_count"], 0)
        self.assertEqual(result["report"]["snapshots"][0]["inventoried_windows"], 3)
        unselected = read_rows(self.out / "unselected_cards.jsonl")[0]
        self.assertIn("generator_call_envelope_invalid", unselected["parent_generation_error_codes"])
        self.assertEqual(result["report"]["inventoried_cards"], 3)
        self.assertNotIn(SECRET, (self.out / "generation_issues.jsonl").read_text())

    def test_unselected_window_without_coverage_stays_in_accounting_as_unassessable(self):
        self.coverage_rows = self.coverage_rows[:1]
        self.refresh()
        result = self.prepare(materialize=True)
        self.assertEqual(result["report"]["inventoried_cards"], 3)
        unselected = read_rows(self.out / "unselected_cards.jsonl")[0]
        self.assertEqual(unselected["schema_span_status"], "unassessable")
        self.assertIsNone(unselected["candidate_sha256"])
        self.assertIn("schema_span_unassessable_without_source_window", unselected["disagreements"])
        issue = read_rows(self.out / "generation_issues.jsonl")[0]
        self.assertIn("coverage_window_missing", issue["error_codes"])
        self.assertEqual(issue["observed_card_count"], 1)

    def test_competing_snapshots_cannot_produce_ambiguous_selected_case_ids(self):
        other = self.root / "competing-snapshot"
        other.mkdir()
        source = copy.deepcopy(self.source)
        generator = other / self.gen.name
        rows = copy.deepcopy(self.rows)
        rows[0]["rationale"] += " different snapshot"
        write_rows(generator, rows)
        job = copy.deepcopy(self.job_data)
        job["output_file_hashes"] = {generator.name: ref(generator)["sha256"]}
        write_json(other / self.job.name, job)
        source["generator"] = ref(generator)
        source["generator_job"] = ref(other / self.job.name)
        self.decision["sources"].append(source)
        self.pin = self.save_decision()
        self.assert_rejected("duplicate_selected_case_id")

    def test_unselected_flags_do_not_certify_and_actual_schema_rejections_win(self):
        unselected = self.rows[1]["cards"][0]
        unselected.update(accepted_for_verification=False, schema_errors=["old_error"], normalized_card=None)
        self.rows[0]["cards"][1]["accepted_for_verification"] = True
        self.rows[0]["cards"][1]["schema_errors"] = []
        self.refresh()
        self.prepare(materialize=True)
        rejected = read_rows(self.out / "rejected_cards.jsonl")[0]
        self.assertIn("span_out_of_bounds", rejected["observed_error_codes"])
        self.assertIn("inherited_acceptance_disagrees_with_current_schema", rejected["disagreements"])
        self.assertIn("inherited_schema_errors_disagree_with_current_schema", rejected["disagreements"])
        valid = read_rows(self.out / "unselected_cards.jsonl")[0]
        self.assertEqual(valid["schema_span_status"], "valid")
        self.assertIn("inherited_accepted_flag_not_true", valid["disagreements"])
        self.assertIn("inherited_schema_errors_not_empty", valid["disagreements"])
        self.assertIn("normalized_card_mismatch", valid["disagreements"])

    def test_rejected_unknown_field_names_and_recorded_errors_cannot_copy_prose(self):
        rejected = self.rows[0]["cards"][1]
        prose = "DO NOT COPY THIS UNKNOWN FIELD'S SOURCE PROSE"
        rejected["generator_card"][prose] = "another private value"
        rejected["schema_errors"] = ["unknown_key:" + prose]
        self.rows[0] = self.make_row("W1", self.rows[0]["cards"])
        self.refresh()
        self.prepare(materialize=True)
        ledger = read_rows(self.out / "rejected_cards.jsonl")[0]
        self.assertEqual(ledger["original_error_codes"], ["unknown_key"])
        self.assertIn("unknown_key", ledger["observed_error_codes"])
        self.assertEqual(ledger["original_error_codes_sha256"], P.candidate_sha256(rejected["schema_errors"]))
        self.assertNotIn(prose, (self.out / "rejected_cards.jsonl").read_text())

    def test_wrong_work_with_colliding_local_ids_rejected_at_all_joins(self):
        baseline = (copy.deepcopy(self.rows), copy.deepcopy(self.job_data), copy.deepcopy(self.coverage_rows),
                    copy.deepcopy(self.sentence_rows))
        for target in ("decision", "job", "generator", "card", "coverage", "sentence"):
            with self.subTest(target=target):
                self.rows, self.job_data, self.coverage_rows, self.sentence_rows = copy.deepcopy(baseline)
                if target == "job":
                    self.job_data["book"] = "wrong-work"
                elif target == "generator":
                    self.rows[1]["work_id"] = "wrong-work"
                elif target == "card":
                    self.rows[1]["cards"][0]["work_id"] = "wrong-work"
                elif target == "coverage":
                    self.coverage_rows[1]["work_id"] = "wrong-work"
                elif target == "sentence":
                    self.sentence_rows[1]["work_id"] = "wrong-work"
                self.refresh()
                if target == "decision":
                    self.decision["sources"][0]["work_id"] = "wrong-work"
                    self.pin = self.save_decision()
                self.assert_rejected("work_mismatch")

    def test_duplicates_in_all_indexes_and_selection_fail(self):
        baseline = (copy.deepcopy(self.rows), copy.deepcopy(self.coverage_rows), copy.deepcopy(self.sentence_rows))
        for target in ("window", "card", "coverage", "sentence", "selected", "snapshot"):
            with self.subTest(target=target):
                self.rows, self.coverage_rows, self.sentence_rows = copy.deepcopy(baseline)
                if target == "window":
                    self.rows.append(copy.deepcopy(self.rows[1]))
                elif target == "card":
                    self.rows[1]["cards"].append(copy.deepcopy(self.rows[0]["cards"][0]))
                elif target == "coverage":
                    self.coverage_rows.append(copy.deepcopy(self.coverage_rows[0]))
                elif target == "sentence":
                    self.sentence_rows.append(copy.deepcopy(self.sentence_rows[0]))
                self.refresh()
                if target == "selected":
                    self.decision["sources"][0]["selected_cards"] *= 2
                elif target == "snapshot":
                    self.decision["sources"] *= 2
                self.pin = self.save_decision()
                self.assert_rejected("duplicate_")

    def test_changed_input_and_repinning_cannot_replace_original_job_bindings(self):
        for path in (self.gen, self.job, self.coverage, self.sentences, self.prompt, self.config, self.selection):
            with self.subTest(path=path):
                before = path.read_bytes()
                path.write_bytes(before + b"\n")
                self.assert_rejected("artifact_hash_mismatch")
                path.write_bytes(before)
        self.sentence_rows[0]["text"] += " changed"
        self.refresh(bind=False)
        self.assert_rejected("job_source_hash_mismatch")
        self.refresh()
        self.rows[1]["rationale"] += " changed"
        self.refresh(seal=False)
        self.assert_rejected("job_output_hash_mismatch")

    def test_duplicate_keys_nonfinite_deep_and_exact_decision_schema(self):
        for data in (b'{"schema_version":1,"schema_version":1}', b'{"schema_version":NaN}',
                     b'{"schema_version":1e999}', b'{"x":' + b'[' * 10000 + b'0' + b']' * 10000 + b'}'):
            self.selection.write_bytes(data)
            self.pin = ref(self.selection)["sha256"]
            self.assert_rejected()
        self.refresh()
        original = copy.deepcopy(self.decision)
        for target in ("version", "extra", "source", "chosen", "empty"):
            self.decision = copy.deepcopy(original)
            if target == "version":
                self.decision["schema_version"] = True
            elif target == "extra":
                self.decision["extra"] = True
            elif target == "source":
                self.decision["sources"][0]["extra"] = True
            elif target == "chosen":
                self.decision["sources"][0]["selected_cards"][0]["extra"] = True
            else:
                self.decision["sources"][0]["selected_cards"] = []
            self.pin = self.save_decision()
            self.assert_rejected()

    def test_strict_jsonl_duplicate_keys_fail_even_unselected(self):
        self.gen.write_bytes(self.gen.read_bytes() + b'{"window_id":"W3","window_id":"W3"}\n')
        self.refresh(store_rows=False)
        self.assert_rejected("duplicate_json_key")

    def test_paths_hash_pins_conflicts_and_job_sibling(self):
        original = copy.deepcopy(self.decision)
        for change in ({"path": "relative.jsonl"}, {"sha256": "A" * 64}, {"sha256": "bad"},
                       {"path": str(self.root / ".." / "outside")}, {"path": str(self.root / "missing")},
                       {"path": str(self.root / "bad:stream")}, {"path": str(self.root / "nul.json")},
                       {"path": "\\\\?\\C:\\device-alias"}):
            self.decision = copy.deepcopy(original)
            self.decision["sources"][0]["generator"].update(change)
            self.pin = self.save_decision()
            self.assert_rejected()
        self.decision = copy.deepcopy(original)
        self.decision["sources"][0]["sentences"] = {**ref(self.coverage), "sha256": "0" * 64}
        self.pin = self.save_decision()
        self.assert_rejected("conflicting_path_pins")
        self.decision = copy.deepcopy(original)
        moved = self.root / "job_record.json"
        moved.write_bytes(self.job.read_bytes())
        self.decision["sources"][0]["generator_job"] = ref(moved)
        self.pin = self.save_decision()
        self.assert_rejected("generator_job_not_sibling")

    def test_job_manifest_paths_and_optional_presence_fail_closed(self):
        baseline = copy.deepcopy(self.job_data)
        for value in (None, [], {}, {self.gen.name: "0" * 64}, {"../escape": "0" * 64},
                      {"calls\\escape": "0" * 64}, {"/escape": "0" * 64}):
            self.job_data = copy.deepcopy(baseline)
            self.job_data["output_file_hashes"] = value
            self.refresh(seal=False)
            self.assert_rejected()

    def test_prompt_content_identity_required_and_profile_cannot_tune_contract(self):
        canonical = self.prompt.read_bytes()
        self.prompt.write_bytes(canonical.replace(b"exactly eight", b"at most eight"))
        self.refresh()
        self.assert_rejected("canonical_v3_prompt_required")
        self.prompt.write_bytes(canonical)
        profile = json.loads(self.config.read_bytes())
        for change in ({"thinking_disabled": True}, {"max_tokens": 1500}, {"max_num_seqs": 8},
                       {"max_model_len": 8192}, {"model": ""}):
            value = copy.deepcopy(profile)
            value["profiles"]["unstructured_analysis"].update(change)
            write_json(self.config, value)
            self.refresh()
            self.assert_rejected("incompatible_ver16000_profile")

    def test_default_cli_dryrun_and_existing_output_refusal(self):
        args = ["--selection", str(self.selection), "--selection-sha256", self.pin, "--out-dir", str(self.out)]
        before = {str(path): path.read_bytes() if path.is_file() else None for path in self.root.rglob("*")}
        with redirect_stdout(io.StringIO()) as output:
            self.assertEqual(P.main(args), 0)
        result = json.loads(output.getvalue())
        self.assertTrue(result["dry_run"])
        self.assertEqual(before, {str(path): path.read_bytes() if path.is_file() else None
                                  for path in self.root.rglob("*")})
        with redirect_stdout(io.StringIO()):
            self.assertEqual(P.main(args + ["--materialize"]), 0)
        contents = {path: path.read_bytes() for path in self.out.iterdir()}
        for suffix in ([], ["--materialize"]):
            with redirect_stderr(io.StringIO()):
                self.assertEqual(P.main(args + suffix), 2)
        self.assertEqual(contents, {path: path.read_bytes() for path in self.out.iterdir()})
        with redirect_stdout(io.StringIO()) as output:
            self.assertEqual(P.main(["--verify-package", str(self.out), "--package-manifest-sha256",
                                     result["package_manifest_sha256"]]), 0)
        self.assertTrue(json.loads(output.getvalue())["package_verified"])
        for args in (["--verify-package", str(self.out)], ["--materialize"],
                     ["--verify-package", str(self.out), "--materialize", "--package-manifest-sha256", "0" * 64]):
            with redirect_stderr(io.StringIO()):
                self.assertEqual(P.main(args), 2)

    def test_output_absolute_and_parent_must_exist(self):
        for out in ("relative", self.root / "missing-parent" / "package"):
            self.out = out
            with self.assertRaises(ValueError):
                self.prepare(materialize=True)
        self.assertFalse((self.root / "missing-parent").exists())

    def test_symlinks_rejected_in_files_and_ancestors(self):
        alias = self.root / "alias"
        try:
            alias.symlink_to(self.attempt, target_is_directory=True)
        except OSError:
            self.skipTest("host cannot create symlinks")
        self.decision["sources"][0]["generator"]["path"] = str(alias / self.gen.name)
        self.pin = self.save_decision()
        self.assert_rejected("unsafe_path_symlink")

        self.out = alias / "package"
        with self.assertRaisesRegex(ValueError, "unsafe_path_symlink"):
            self.prepare()
        link = self.root / "linked-sentences.jsonl"
        link.symlink_to(self.sentences)
        self.decision["sources"][0]["generator"] = ref(self.gen)
        self.decision["sources"][0]["sentences"] = ref(link)
        self.pin = self.save_decision()
        self.out = self.root / "package"
        self.assert_rejected("unsafe_path_symlink")

    def test_reparse_point_rejection_without_symlink_privileges(self):
        lstat = Path.lstat

        def attributes(path):
            info = lstat(path)
            if path == self.attempt:
                return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400)
            return info

        with mock.patch.object(Path, "lstat", autospec=True, side_effect=attributes):
            self.assert_rejected("unsafe_path_symlink")

    def test_final_rehash_detects_concurrent_changes_without_any_output(self):
        render = P.C.render_evidence

        def mutate(*args):
            self.sentences.write_bytes(self.sentences.read_bytes() + b"\n")
            return render(*args)

        with mock.patch.object(P.C, "render_evidence", side_effect=mutate):
            self.assert_rejected("artifact_changed_during_validation")

    def test_deterministic_outputs_and_parse_index_cache_once_per_snapshot(self):
        self.selected.append({"card_id": "W2#0", "candidate_sha256": P.candidate_sha256(self.card)})
        self.refresh()
        with mock.patch.object(P, "strict_json", wraps=P.strict_json) as parse:
            outputs, report, inputs = P.compile_package(self.selection, self.pin)
        # decision/config/job objects, six source/gen JSONL rows, and two raw payloads.
        self.assertEqual(parse.call_count, 11)
        self.assertEqual(len(inputs.rows), 3)
        self.assertEqual(len(inputs.indexes), 3)
        self.assertEqual(report["counts"]["verifier_inputs"], 2)
        second, _, _ = P.compile_package(self.selection, self.pin)
        self.assertEqual(outputs, second)
        self.prepare(materialize=True)
        other = self.root / "second-package"
        P.prepare(self.selection, self.pin, other, materialize=True)
        self.assertEqual({p.name: p.read_bytes() for p in self.out.iterdir()},
                         {p.name: p.read_bytes() for p in other.iterdir()})

    def test_package_tamper_external_pin_full_inventory_and_reconstruction(self):
        result = self.prepare(materialize=True)
        pin = result["package_manifest_sha256"]
        before = {p: p.read_bytes() for p in self.out.iterdir()}
        for path in before:
            with self.subTest(path=path):
                path.write_bytes(before[path] + b"\n")
                with self.assertRaises(ValueError):
                    P.verify_package(self.out, pin)
                path.write_bytes(before[path])
        extra = self.out / "extra.txt"
        extra.write_bytes(b"unexpected")
        with self.assertRaisesRegex(ValueError, "unexpected_package_entries"):
            P.verify_package(self.out, pin)
        extra.unlink()
        selected = read_rows(self.out / "verifier_inputs.jsonl")
        selected[0]["messages"][1]["content"] += "Change the contract"
        write_rows(self.out / "verifier_inputs.jsonl", selected)
        manifest_path = self.out / "package_manifest.json"
        manifest = json.loads(manifest_path.read_bytes())
        manifest["output_file_hashes"]["verifier_inputs.jsonl"] = ref(self.out / "verifier_inputs.jsonl")["sha256"]
        write_json(manifest_path, manifest)
        with self.assertRaisesRegex(ValueError, "package_reconstruction_mismatch"):
            P.verify_package(self.out, ref(manifest_path)["sha256"])
        for path, data in before.items():
            path.write_bytes(data)
        self.sentences.write_bytes(self.sentences.read_bytes() + b"\n")
        with self.assertRaisesRegex(ValueError, "artifact_hash_mismatch"):
            P.verify_package(self.out, pin)

    def test_verification_rejects_entries_added_during_first_reconstruction(self):
        result = self.prepare(materialize=True)
        before = {p: p.read_bytes() for p in self.out.iterdir()}
        compile_package = P.compile_package
        extra = self.out / "unexpected.jsonl"
        for directory in (False, True):
            with self.subTest(directory=directory):
                def add_entry(*args):
                    compiled = compile_package(*args)
                    if directory:
                        extra.mkdir()
                    else:
                        extra.write_bytes(b"unexpected fixture\n")
                    return compiled

                with mock.patch.object(P, "compile_package", side_effect=add_entry) as compile_mock:
                    with self.assertRaisesRegex(ValueError, "unexpected_package_entries"):
                        P.verify_package(self.out, result["package_manifest_sha256"])
                self.assertEqual(compile_mock.call_count, 1)
                self.assertEqual(before, {p: p.read_bytes() for p in before})
                self.assertTrue(extra.exists())
                if directory:
                    extra.rmdir()
                else:
                    self.assertEqual(extra.read_bytes(), b"unexpected fixture\n")
                    extra.unlink()

    def test_verification_rechecks_directory_after_final_file_hashes(self):
        result = self.prepare(materialize=True)
        before = {p: p.read_bytes() for p in self.out.iterdir()}
        recheck = P.Inputs.recheck
        extra = self.out / "late-unexpected.jsonl"

        def add_after_recheck(store):
            recheck(store)
            if self.out / "package_manifest.json" in store.files:
                extra.write_bytes(b"late fixture\n")

        with mock.patch.object(P.Inputs, "recheck", autospec=True, side_effect=add_after_recheck):
            with self.assertRaisesRegex(ValueError, "unexpected_package_entries"):
                P.verify_package(self.out, result["package_manifest_sha256"])
        self.assertEqual(before, {p: p.read_bytes() for p in before})
        self.assertEqual(extra.read_bytes(), b"late fixture\n")

    def test_verification_rechecks_known_entries_for_directory_symlink_and_reparse(self):
        result = self.prepare(materialize=True)
        before = {p: p.read_bytes() for p in self.out.iterdir()}
        compile_package, lstat = P.compile_package, Path.lstat
        target = self.out / "rejected_cards.jsonl"
        reconstructed = False

        def mark_reconstructed(*args):
            nonlocal reconstructed
            compiled = compile_package(*args)
            reconstructed = True
            return compiled

        for entry_type in ("directory", "symlink", "reparse"):
            with self.subTest(entry_type=entry_type):
                reconstructed = False

                def attributes(path):
                    info = lstat(path)
                    if reconstructed and path == target:
                        return SimpleNamespace(st_mode={"directory": 0o040755, "symlink": 0o120777,
                                                        "reparse": info.st_mode}[entry_type],
                                               st_file_attributes=0x400 if entry_type == "reparse" else 0)
                    return info

                with mock.patch.object(P, "compile_package", side_effect=mark_reconstructed), \
                     mock.patch.object(Path, "lstat", autospec=True, side_effect=attributes):
                    with self.assertRaisesRegex(ValueError, "package_regular_file_required|unsafe_path_symlink"):
                        P.verify_package(self.out, result["package_manifest_sha256"])
                self.assertEqual(before, {p: p.read_bytes() for p in self.out.iterdir()})

    def test_two_works_can_share_local_ids_without_cross_work_merge(self):
        other = self.root / "other-work"
        other.mkdir()
        source = copy.deepcopy(self.source)
        for key in P.ARTIFACTS:
            path = Path(source[key]["path"])
            target = other / path.name
            target.write_bytes(path.read_bytes().replace(WORK.encode(), b"other-work"))
            source[key] = ref(target)
        job = json.loads((other / self.job.name).read_bytes())
        job["input_artifact_hashes"] = {"coverage_partition.jsonl": source["coverage"]["sha256"],
                                         "sentences.jsonl": source["sentences"]["sha256"]}
        job["output_file_hashes"] = {self.gen.name: source["generator"]["sha256"]}
        write_json(other / self.job.name, job)
        source["generator_job"] = ref(other / self.job.name)
        source["work_id"] = "other-work"
        self.decision["sources"].append(source)
        self.pin = self.save_decision()
        result = self.prepare(materialize=True)
        selected = read_rows(self.out / "verifier_inputs.jsonl")
        self.assertEqual([row["work_id"] for row in selected], [WORK, "other-work"])
        self.assertEqual([row["card_id"] for row in selected], ["W1#0", "W1#0"])
        self.assertNotEqual(selected[0]["case_id"], selected[1]["case_id"])
        self.assertEqual(result["report"]["inventoried_cards"], 6)

    def test_candidate_hash_matches_selector_canonical_rule(self):
        self.assertEqual(P.canonical_bytes({"z": "\u4e16\u754c", "a": [1, True, None]}),
                         b'{"a":[1,true,null],"z":"\\u4e16\\u754c"}')
        with self.assertRaises(ValueError):
            P.candidate_sha256({"a": float("nan")})


if __name__ == "__main__":
    unittest.main()
