"""Offline contract regressions. All dispatch is mocked; artifacts are temporary."""
import copy
import hashlib
import http.client
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("canary_contract_test", ROOT / "tools/proposition_canary_run.py")
C = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(C)
SID = "B001:C0001:S000001"
SID2 = "B001:C0001:S000002"
CHAPTER = "B001:C0001"
BOOK = "contract-book"
MODEL = "expected-model"
PROFILE = {"endpoint": "http://localhost:8000/v1/chat/completions", "model": MODEL,
           "thinking_disabled": True, "max_num_seqs": 1, "max_tokens": 1500}
VER_PROFILE = {**PROFILE, "endpoint": "http://localhost:8001/v1/chat/completions"}


def source(sid=SID):
    # Real sentence records may omit work_id or declare it as null.
    return {"sentence_id": sid, "chapter_id": CHAPTER, "text": "Alice says the gate might open."}


def record(wid="W000001"):
    return {"window_id": wid, "chapter_id": CHAPTER, "role": "rule_atom_read",
            "anchor_sentence_ids": [SID], "attached_sentence_ids": []}


def window():
    return C.build_window(record(), {SID: source(), SID2: source(SID2)})


def card():
    return {"primary_route": "bounded_event", "proposition_text": "The gate opens.",
            "evidence_ids": [SID], "evidence_spans": [{"sentence_id": SID, "start": 0, "end": 29}],
            "assertion_status": "narrator_asserted", "temporal_status": "bounded_occurrence",
            "evidence_directness": "explicit", "content_facets": ["bounded_event"],
            "generality_scope": "instance", "claimant_or_source": None}


def verdict(case_id="case-1", overall="entailed"):
    return {"case_id": case_id, "overall": overall, "no_runtime_effect": True,
            "checks": [{"field_path": field, "verdict": overall, "evidence_ids": [SID],
                        "reason": "Source-grounded check."} for field in C.REQUIRED_VERIFIER_FIELDS]}


def block(value):
    return "<VERDICT_JSON>" + json.dumps(value) + "</VERDICT_JSON>"


def vmeta(value=None):
    return {"http_status": 200, "model": MODEL, "finish_reason": "stop", "error": None,
            "content": block(value if value is not None else verdict())}


def envelope(content, **changes):
    result = {"model": MODEL, "choices": [{"finish_reason": "stop", "message": {"content": content}}]}
    result.update(changes)
    return result


class Response:
    status = 200

    def __init__(self, raw, exit_error=None):
        self.raw = raw if isinstance(raw, bytes) else json.dumps(raw).encode("utf-8")
        self.exit_error = exit_error

    def __enter__(self):
        return self

    def __exit__(self, *args):
        if self.exit_error:
            raise self.exit_error

    def read(self):
        return self.raw


class CallCaptureTests(unittest.TestCase):
    def test_response_saved_and_fsynced_before_json_parse(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / "call"
            raw = b"{bad-json-and-complete-failure-envelope"
            real_parser = C.strict_json

            def parse(content):
                self.assertEqual((directory / "response_body.bin").read_bytes(), raw)
                self.assertTrue((directory / "request_body.bin").is_file())
                return real_parser(content)

            with mock.patch.object(C.urllib.request.OpenerDirector, "open", return_value=Response(raw)) as opener, \
                 mock.patch.object(C, "strict_json", side_effect=parse), \
                 mock.patch.object(C.os, "fsync", wraps=os.fsync) as sync:
                result = C.call_model(PROFILE, [], 20, capture_dir=directory)
            self.assertIsNotNone(result["error"])
            self.assertEqual(opener.call_count, 1)
            self.assertGreaterEqual(sync.call_count, 4)
            self.assertEqual(result["attempts"], 1)

    def test_http_error_body_preserved_without_retry_or_auth_capture(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / "call"
            raw = b'{"error":{"message":"service unavailable"}}'
            error = urllib.error.HTTPError(PROFILE["endpoint"], 503, "error", {}, io.BytesIO(raw))
            with mock.patch.object(C.urllib.request.OpenerDirector, "open", side_effect=error) as opener, \
                 mock.patch.dict(os.environ, {"CANARY_TEST_SECRET": "never-save-this-key"}):
                result = C.call_model({**PROFILE, "api_key_env": "CANARY_TEST_SECRET"}, [], 20,
                                      capture_dir=directory)
            self.assertEqual(opener.call_count, 1)
            self.assertEqual(result["error"], "http_503")
            self.assertEqual((directory / "response_body.bin").read_bytes(), raw)
            for path in directory.iterdir():
                self.assertNotIn(b"never-save-this-key", path.read_bytes())

    def test_interruption_after_read_keeps_raw_and_directory_cannot_be_reused(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / "call"
            raw = json.dumps(envelope("{}")).encode()
            with mock.patch.object(C.urllib.request.OpenerDirector, "open", return_value=Response(raw, KeyboardInterrupt())) as opener:
                with self.assertRaises(KeyboardInterrupt):
                    C.call_model(PROFILE, [], 20, capture_dir=directory)
                self.assertEqual((directory / "response_body.bin").read_bytes(), raw)
                self.assertIn("interrupted", (directory / "journal.jsonl").read_text())
                with self.assertRaises(FileExistsError):
                    C.call_model(PROFILE, [], 20, capture_dir=directory)
                self.assertEqual(opener.call_count, 1)

    def test_strict_envelopes(self):
        invalid = [
            {"choices": [{"finish_reason": "stop", "message": {"content": "{}"}}]},
            envelope("{}", model="wrong"), envelope("{}", choices=[]),
            envelope("{}", choices=envelope("{}")["choices"] * 2),
            envelope("{}", choices=[{"finish_reason": "length", "message": {"content": "{}"}}]),
            envelope(None), envelope([]), envelope({}),
            {"model": MODEL, "choices": [None]},
        ]
        for payload in invalid:
            with self.subTest(payload=payload), \
                 mock.patch.object(C.urllib.request.OpenerDirector, "open", return_value=Response(payload)) as opener:
                result = C.call_model(PROFILE, [], 20)
                self.assertIsNotNone(result["error"])
                self.assertEqual(opener.call_count, 1)
        with mock.patch.object(C.urllib.request.OpenerDirector, "open", return_value=Response(envelope(""))):
            self.assertIsNone(C.call_model(PROFILE, [], 20)["error"])

    def test_transport_is_single_attempt_and_does_not_save_exception_secrets(self):
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(C.urllib.request.OpenerDirector, "open", side_effect=ValueError("secret=credential")) as opener:
            result = C.call_model(PROFILE, [], 20, capture_dir=Path(tmp) / "call")
            self.assertEqual(opener.call_count, 1)
            self.assertEqual(result["error"], "ValueError")
            self.assertNotIn("credential", json.dumps(result))

    def test_redirect_cannot_issue_a_hidden_second_request(self):
        opener = C.urllib.request.build_opener(C.NoRedirect)
        handlers = [handler for handler in opener.handlers if isinstance(handler, C.NoRedirect)]
        self.assertEqual(len(handlers), 1)
        request = C.urllib.request.Request(PROFILE["endpoint"], data=b"{}")
        self.assertIsNone(handlers[0].redirect_request(request, None, 302, "redirect", {}, "http://other/"))
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(C.urllib.request.OpenerDirector, "open", side_effect=urllib.error.HTTPError(
                 PROFILE["endpoint"], 302, "redirect", {}, io.BytesIO(b"redirect evidence"))) as dispatch:
            result = C.call_model(PROFILE, [], 20, capture_dir=Path(tmp) / "call")
            self.assertEqual(dispatch.call_count, 1)
            self.assertEqual(result["error"], "http_302")

    def test_incomplete_success_and_http_error_reads_preserve_partial_without_parsing(self):
        # Even a syntactically valid partial envelope must never be accepted.
        partial = json.dumps(envelope('{"propositions":[]}')).encode()
        for status in (200, 503):
            for capture in (False, True):
                with self.subTest(status=status, capture=capture), tempfile.TemporaryDirectory() as tmp:
                    directory = Path(tmp) / "call" if capture else None
                    if status == 200:
                        response = Response(b"")
                        open_options = {"return_value": response}
                    else:
                        response = urllib.error.HTTPError(PROFILE["endpoint"], status, "error", {}, io.BytesIO())
                        open_options = {"side_effect": response}
                    response.read = mock.Mock(side_effect=http.client.IncompleteRead(partial, 20))
                    with mock.patch.object(C.urllib.request.OpenerDirector, "open", **open_options) as opener, \
                         mock.patch.object(C, "strict_json", side_effect=AssertionError("incomplete body parsed")), \
                         mock.patch.object(C.os, "fsync", wraps=os.fsync) as sync:
                        result = C.call_model(PROFILE, [], 20, capture_dir=directory)
                    self.assertEqual(opener.call_count, 1)
                    self.assertEqual(result["error"], "IncompleteRead")
                    self.assertEqual(result["http_status"], status)
                    self.assertIs(result["response_incomplete"], True)
                    self.assertEqual(result["content"], "")
                    if capture:
                        self.assertGreaterEqual(sync.call_count, 4)
                        self.assertEqual((directory / "response_body.bin").read_bytes(), partial)
                        journal = C.read_jsonl(str(directory / "journal.jsonl"))
                        self.assertEqual(journal[1]["stage"], "response_incomplete")
                        self.assertEqual(journal[1]["sha256"], hashlib.sha256(partial).hexdigest())
                        self.assertNotIn("response_saved", [row["stage"] for row in journal])


class SourceAndCardTests(unittest.TestCase):
    def test_credential_bearing_profile_endpoints_cannot_enter_job_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "worker_config.json"
            for endpoint in ("http://user:secret@localhost:8000/v1/chat/completions",
                             "http://localhost:8000/v1/chat/completions?api_key=secret"):
                config.write_text(json.dumps({"profiles": {"structured_source": {**PROFILE, "endpoint": endpoint}}}),
                                  encoding="utf-8")
                with mock.patch.object(C, "REPO", tmp), self.assertRaisesRegex(SystemExit, "credential-bearing"):
                    C.load_profile()

    def test_no_dropped_missing_or_duplicate_anchors(self):
        for changes in ({"anchor_sentence_ids": [SID, SID]}, {"anchor_sentence_ids": [SID2]},
                        {"attached_sentence_ids": [SID]}, {"anchor_sentence_ids": []},
                        {"anchor_sentence_ids": SID}, {"chapter_id": "garbage"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                C.build_window({**record(), **changes}, {SID: source()})

    def test_source_text_and_actual_chapter_prefix_required(self):
        for changes in ({"text": ""}, {"text": " "}, {"text": None}, {"text": []},
                        {"chapter_id": "B002:C0001"}, {"sentence_id": SID2}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                C.build_window(record(), {SID: {**source(), **changes}})
        self.assertEqual(window()["sentence_ids"], [SID])

    def test_preflight_rejects_duplicate_ids_and_declared_wrong_work(self):
        cases = [([record(), record()], [source()]), ([record()], [source(), source()]),
                 ([record()], [{**source(), "work_id": "another-book"}]),
                 ([{**record(), "work_id": "another-book"}], [source()])]
        for coverage, sentences in cases:
            with self.subTest(coverage=coverage, sentences=sentences), self.assertRaises(ValueError):
                C.preflight_sources(coverage, sentences, BOOK, {"rule_atom_read"}, 0)

    def test_card_types_unknown_fields_duplicates_and_boolean_offsets_fail_closed(self):
        mutations = [
            {"extra": "not permitted"}, {"claimant_or_source": " "}, {"claimant_or_source": 1},
            {"claimant_or_source": {}}, {"proposition_text": []}, {"primary_route": []},
            {"content_facets": [["bounded_event"]]}, {"content_facets": ["bounded_event"] * 2},
            {"evidence_ids": [SID, SID]}, {"evidence_ids": [{}]}, {"evidence_ids": []},
            {"evidence_spans": [{"sentence_id": SID, "start": False, "end": 3}]},
            {"evidence_spans": [{"sentence_id": SID, "start": 0, "end": True}]},
            {"evidence_spans": card()["evidence_spans"] * 2},
            {"evidence_spans": [{"sentence_id": [], "start": 0, "end": 3}]},
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                normalized, errors = C.validate_card({**card(), **mutation}, window())
                self.assertIsNone(normalized)
                self.assertTrue(errors)
        missing = card()
        del missing["claimant_or_source"]
        self.assertTrue(C.validate_card(missing, window())[1])

    def test_unresolved_attribution_is_structurally_allowed_without_inventing_speaker(self):
        unresolved = {**card(), "assertion_status": "direct_speech_claim"}
        normalized, errors = C.validate_card(unresolved, window())
        self.assertEqual(errors, [])
        self.assertIsNone(normalized["claimant_or_source"])

    def test_duplicate_json_keys_at_all_levels_fail(self):
        for content in ('{"propositions":[],"propositions":[]}',
                        '{"propositions":[{"evidence_ids":[],"evidence_ids":[]}]}',
                        '{"propositions":[],"bad":NaN}'):
            self.assertIsNone(C.parse_strict(content)[0])


class VerifierContractTests(unittest.TestCase):
    def parse(self, payload=None, candidate=None, meta=None, win=None):
        return C.parse_verifier_card(meta if meta is not None else vmeta(payload), "case-1",
                                     win or window(), candidate if candidate is not None else card(), MODEL)

    def test_all_semantic_fields_required_and_prompt_in_sync(self):
        self.assertEqual(set(C.REQUIRED_VERIFIER_FIELDS), set(C.CARD_KEYS) - {"evidence_ids", "evidence_spans"})
        prompt = (Path(C.BASE) / C.VER_PROMPT_CONTRACT).read_text(encoding="utf-8")
        fields = prompt.split("including null-valued fields:\n", 1)[1].split("\n\n", 1)[0].splitlines()
        self.assertEqual(tuple(fields), C.REQUIRED_VERIFIER_FIELDS)
        self.assertEqual(len(fields), 8)
        self.assertIn("contradicted > insufficient_evidence > abstain > entailed", prompt)
        self.assertEqual(self.parse()[-1], [])
        for field in C.REQUIRED_VERIFIER_FIELDS:
            value = verdict()
            value["checks"] = [c for c in value["checks"] if c["field_path"] != field]
            self.assertIn("required_field_coverage", self.parse(value)[-1])

    def test_rejects_empty_duplicate_unknown_and_malformed_checks(self):
        values = []
        for changes in ({"checks": []}, {"checks": None}, {"unexpected": True},
                        {"no_runtime_effect": 1}, {"case_id": "other"}, {"overall": []}):
            values.append({**verdict(), **changes})
        for changes in ({"field_path": "evidence_ids"}, {"field_path": []}, {"verdict": "yes"},
                        {"reason": " "}, {"evidence_ids": []}, {"evidence_ids": [SID, SID]},
                        {"evidence_ids": [{}]}, {"unexpected": True}):
            value = verdict()
            value["checks"][0].update(changes)
            values.append(value)
        duplicate = verdict()
        duplicate["checks"].append(duplicate["checks"][0])
        values.append(duplicate)
        for value in values:
            with self.subTest(value=value):
                parsed = self.parse(value)
                self.assertIsNone(parsed[0])
                self.assertTrue(parsed[-1])

    def test_citations_must_be_from_actually_sent_card_not_rest_of_window(self):
        win = C.build_window({**record(), "attached_sentence_ids": [SID2]}, {SID: source(), SID2: source(SID2)})
        value = verdict()
        value["checks"][0]["evidence_ids"] = [SID2]
        self.assertIn("cited_outside_sent_card_evidence", self.parse(value, win=win)[-1])

    def test_entailment_needs_supplied_card_and_expected_model(self):
        for kwargs in ({}, {"card": card()}, {"expected_model": MODEL},
                       {"card": card(), "expected_model": "wrong"}):
            result = C.parse_verifier_card(vmeta(), "case-1", window(), **kwargs)
            self.assertIsNone(result[0])
            self.assertTrue(result[-1])
        for changes in ({"http_status": 500}, {"finish_reason": "length"}, {"error": "transport"}):
            self.assertTrue(self.parse(meta={**vmeta(), **changes})[-1])

    def test_reconciliation_precedence_and_valid_negative_results(self):
        for overall in C.CONTRACT_OVERALL:
            value = verdict(overall=overall)
            value["checks"][0]["verdict"] = "entailed"
            parsed = self.parse(value)
            self.assertEqual(parsed[-1], [])
            self.assertEqual(parsed[0], C.OVERALL_TO_VERDICT[overall])
        value = verdict()
        value["checks"][0]["verdict"] = "insufficient_evidence"
        self.assertIn("overall_check_mismatch", self.parse(value)[-1])
        value["checks"][1]["verdict"] = "contradicted"
        value["overall"] = "contradicted"
        self.assertEqual(self.parse(value)[-1], [])

    def test_null_attribution_cannot_be_certified_as_narrator_or_fact(self):
        candidate = {**card(), "assertion_status": "direct_speech_claim"}
        self.assertIn("unresolved_claimant_requires_insufficient", self.parse(candidate=candidate)[-1])
        value = verdict()
        value["checks"][-1]["verdict"] = "insufficient_evidence"
        value["overall"] = "insufficient_evidence"
        self.assertEqual(self.parse(value, candidate)[-1], [])

    def test_duplicate_json_keys_fail_even_inside_checks(self):
        content = block(verdict()).replace('"overall": "entailed"', '"overall":"entailed","overall":"entailed"')
        self.assertTrue(self.parse(meta={**vmeta(), "content": content})[-1])
        content = block(verdict()).replace('"reason": "Source-grounded check."', '"reason":"x","reason":"y"')
        self.assertTrue(self.parse(meta={**vmeta(), "content": content})[-1])

    def test_literal_present_does_not_force_semantic_entailment(self):
        candidate = card()
        candidate["proposition_text"] = source()["text"]  # Exact literal, but attributed and modal.
        value = verdict(overall="insufficient_evidence")
        result = self.parse(value, candidate)
        self.assertEqual(result[0], "insufficient")
        self.assertEqual(result[-1], [])


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        tmp = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.root = Path(tmp)
        self.repo = self.root / "repo"
        self.base = self.repo / "runs/_extraction_scheduler/20260924"
        self.coverage_path = self.base / C._WAVEA_COVERAGE_ROOT / BOOK / "coverage_partition.jsonl"
        self.sentences_path = self.repo / "runs" / BOOK / C._WAVEA[0] / C._WAVEA[1]
        self.coverage_path.parent.mkdir(parents=True)
        self.sentences_path.parent.mkdir(parents=True)
        for relative in (C.GEN_PROMPT, C.VER_PROMPT_CONTRACT):
            target = self.base / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((Path(C.BASE) / relative).read_bytes())
        (self.base / "source_proposition_audit_gates_v1.json").write_text("{}", encoding="utf-8")
        self.stack.enter_context(mock.patch.object(C, "REPO", str(self.repo)))
        self.stack.enter_context(mock.patch.object(C, "BASE", str(self.base)))
        self.stack.enter_context(mock.patch.object(C, "load_profile", side_effect=lambda name: (
            dict(VER_PROFILE) if name == "unstructured_analysis" else dict(PROFILE))))
        self.stack.enter_context(mock.patch.dict(os.environ, {"DISABLE_LLM_THINKING": "1",
                                                             "CANARY_GEN_PROFILE": "structured_source"}))
        self.opener = self.stack.enter_context(mock.patch.object(C.urllib.request.OpenerDirector, "open",
                                                                 side_effect=AssertionError("unexpected live call")))
        self.coverage = [record()]
        self.sources = [source()]
        self.save_sources()

    def save_sources(self):
        for path, rows in ((self.coverage_path, self.coverage), (self.sentences_path, self.sources)):
            path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")

    def run_main(self, name="output", extra=()):
        out = self.root / name
        with mock.patch.object(sys, "argv", ["canary", "--book", BOOK, "--out-dir", str(out), *extra]), \
             redirect_stdout(io.StringIO()):
            rc = C.main()
        report = json.loads((out / "validation_report.json").read_text(encoding="utf-8")) if out.exists() else None
        return rc, report, out

    def dispatch(self, generator=None, verifier=None):
        def opener(request, timeout):
            body = json.loads(request.data)
            if ":8000/" in request.full_url:
                content = json.dumps({"propositions": [] if generator is None else generator})
            else:
                user = body["messages"][-1]["content"]
                case_id = user.split("CASE_ID: ", 1)[1].split("\n", 1)[0]
                content = block(verifier(case_id) if verifier else verdict(case_id))
            return Response(envelope(content))
        self.opener.side_effect = opener

    def assert_failed(self, report):
        self.assertFalse(report["ok"])
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["acceptance_contract_version"], 2)
        self.assertFalse(report["quality_certified"])

    def test_empty_proposals_complete_and_no_work_exact_zero_counts_and_stale_refusal(self):
        self.dispatch()
        rc, report, out = self.run_main()
        self.assertEqual(rc, 0)
        self.assertTrue(report["verification_complete"])
        self.assertEqual(report["verifier_attempts"], 0)
        self.coverage = []
        self.save_sources()
        self.opener.reset_mock()
        rc, report, out = self.run_main("no-work")
        self.assertEqual(rc, 0)
        self.assertEqual(report["status"], "no_eligible_windows")
        self.assertFalse(report["candidate_output_written"])
        self.assertEqual(sorted(p.name for p in out.iterdir()), ["job_record.json", "validation_report.json"])
        self.assertEqual(json.loads((out / "job_record.json").read_text())["output_file_hashes"], {})
        for key, value in report.items():
            if type(value) is int and key != "acceptance_contract_version":
                self.assertEqual(value, 0, key)
        for extra in ((), ("--overwrite",), ("--dry-run", "--overwrite")):
            with self.assertRaisesRegex(SystemExit, "fresh --out-dir"):
                self.run_main("no-work", extra)
        self.opener.assert_not_called()

    def test_offline_dry_run_and_invalid_later_window_predispatch(self):
        rc, report, out = self.run_main(extra=("--dry-run",))
        self.assertEqual(rc, 0)
        self.assertIsNone(report)
        self.assertFalse(out.exists())
        self.coverage = [record(f"W{i:06}") for i in range(7)]
        self.coverage[-1]["anchor_sentence_ids"] = [SID2]
        self.save_sources()
        for extra in ((), ("--dry-run",)):
            with self.assertRaisesRegex(SystemExit, "missing_source_id"):
                self.run_main(extra=extra)
        self.opener.assert_not_called()

    def test_duplicate_sentence_and_window_ids_never_dict_collapse_in_main(self):
        for duplicate in ("sentence", "window"):
            self.sources = [source()] * (2 if duplicate == "sentence" else 1)
            self.coverage = [record()] * (2 if duplicate == "window" else 1)
            self.save_sources()
            with self.assertRaisesRegex(SystemExit, "duplicate"):
                self.run_main()
        self.opener.assert_not_called()

    def test_first_and_after_smoke_generator_failures_are_fail_stop(self):
        self.coverage = [record(f"W{i:06}") for i in range(8)]
        self.save_sources()
        for index in (0, C.SMOKE_WINDOWS + 1):
            for bad in ("not-json", '{"propositions":{}}', '{"propositions":[],"unknown":0}'):
                with self.subTest(index=index, bad=bad):
                    replies = [Response(envelope('{"propositions":[]}')) for _ in range(index)]
                    replies.append(Response(envelope(bad)))
                    self.opener.side_effect = replies
                    self.opener.reset_mock()
                    rc, report, out = self.run_main(f"failure-{index}-{hashlib.sha256(bad.encode()).hexdigest()[:8]}")
                    self.assertEqual(rc, 1)
                    self.assert_failed(report)
                    self.assertEqual(report["window_errors"], 1)
                    self.assertEqual(report["windows_processed"], index + 1)
                    self.assertEqual(report["windows_unattempted"], 7 - index)
                    self.assertEqual(self.opener.call_count, index + 1)
                    self.assertEqual(len(C.read_jsonl(str(out / "checkpoint.jsonl"))), index)
                    self.assertTrue((out / "calls" / f"{index + 1:06}_generator/response_body.bin").is_file())

    def test_every_transport_or_envelope_failure_stops_new_requests(self):
        self.coverage = [record(), record("W000002")]
        self.save_sources()
        failures = [urllib.error.URLError("offline"), Response(envelope("{}", model="wrong")),
                    Response(envelope("{}", choices=[])), Response(b"bad envelope json")]
        for index, failure in enumerate(failures):
            self.opener.side_effect = [failure]
            self.opener.reset_mock()
            rc, report, _ = self.run_main(f"transport-{index}")
            self.assertEqual(rc, 1)
            self.assert_failed(report)
            self.assertEqual(self.opener.call_count, 1)
            self.assertEqual(report["envelope_errors"], 1)
            self.assertEqual(report["unattempted_window_ids"], ["W000002"])

    def test_all_cards_validated_before_verification_and_never_truncated(self):
        self.dispatch([card(), {**card(), "claimant_or_source": []}, card()])
        rc, report, _ = self.run_main()
        self.assertEqual(rc, 1)
        self.assertEqual(self.opener.call_count, 1)
        self.assertEqual(report["proposer_cards"], 3)
        self.assertEqual(report["cards_schema_or_span_rejected"], 1)
        self.assertEqual(report["cards_unattempted"], 2)
        self.dispatch([card()] * 4)
        self.opener.reset_mock()
        rc, report, _ = self.run_main("too-many")
        self.assertEqual(rc, 1)
        self.assertEqual(report["proposer_cards"], 4)
        self.assertEqual(self.opener.call_count, 1)

    def test_verifier_contract_failure_stops_remaining_cards_and_windows(self):
        self.coverage = [record(), record("W000002")]
        self.save_sources()
        self.dispatch([card(), card()], lambda cid: {**verdict(cid), "checks": []})
        rc, report, _ = self.run_main()
        self.assertEqual(rc, 1)
        self.assert_failed(report)
        self.assertEqual(self.opener.call_count, 2)
        self.assertEqual(report["cards_verified"], 1)
        self.assertEqual(report["verifier_attempts"], 1)
        self.assertEqual(report["cards_valid"], 0)
        self.assertEqual(report["cards_unusable"], 1)
        self.assertEqual(report["cards_unattempted"], 1)
        self.assertEqual(report["unattempted_card_ids"], ["W000001#1"])
        self.assertEqual(report["unattempted_window_ids"], ["W000002"])

    def test_after_smoke_span_and_verifier_failures_also_stop_dispatch(self):
        self.coverage = [record(f"W{i:06}") for i in range(8)]
        self.save_sources()
        index = C.SMOKE_WINDOWS + 1
        for kind in ("span", "verifier"):
            replies = [Response(envelope('{"propositions":[]}')) for _ in range(index)]
            proposal = card()
            if kind == "span":
                proposal["evidence_spans"][0]["end"] = 99999
            replies.append(Response(envelope(json.dumps({"propositions": [proposal]}))))
            if kind == "verifier":
                replies.append(Response(envelope(block({**verdict(), "checks": []}))))
            self.opener.side_effect = replies
            self.opener.reset_mock()
            rc, report, _ = self.run_main(f"late-{kind}")
            self.assertEqual(rc, 1)
            self.assert_failed(report)
            self.assertEqual(report["window_errors"], 1)
            self.assertEqual(report["windows_processed"], index + 1)
            self.assertEqual(self.opener.call_count, index + 1 + (kind == "verifier"))
            self.assertEqual(report["unattempted_window_ids"], ["W000007"])

    def test_report_contract_matches_shared_scheduler_validator(self):
        spec = importlib.util.spec_from_file_location("canary_scheduler_contract", ROOT / "tools/proposition_attempts.py")
        attempts = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(attempts)
        self.dispatch([card()], lambda cid: verdict(cid, "insufficient_evidence"))
        _, report, out = self.run_main()
        self.assertEqual(attempts.validated_report_status(out), "completed")
        self.assertEqual(report["proposer_cards"], report["cards_schema_or_span_rejected"]
                         + report["verifier_attempts"] + report["cards_unattempted"])
        self.assertEqual(report["verifier_attempts"], report["cards_valid"] + report["cards_unusable"])
        _, _, out = self.reverify(out / "proposition_generator.jsonl")
        self.assertEqual(attempts.validated_report_status(out), "completed")
        self.coverage = []
        self.save_sources()
        _, _, out = self.run_main("none")
        self.assertEqual(attempts.validated_report_status(out), "no_eligible_windows")

    def assert_output_manifest(self, out):
        job = json.loads((out / "job_record.json").read_text(encoding="utf-8"))
        hashes = job["output_file_hashes"]
        expected = {path.relative_to(out).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                    for path in out.rglob("*") if path.is_file()
                    and path.relative_to(out).as_posix() not in {"job_record.json", "validation_report.json"}}
        self.assertEqual(hashes, expected)
        self.assertTrue(all("\\" not in path for path in hashes))
        if (out / "stage_journal.jsonl").exists():
            self.assertEqual(C.read_jsonl(str(out / "stage_journal.jsonl"))[-1]["stage"], "terminal")
        return hashes

    def test_output_manifest_covers_generation_reverify_empty_queues_and_terminal_journal(self):
        self.dispatch([card()], lambda cid: verdict(cid, "insufficient_evidence"))
        rc, _, out = self.run_main()
        self.assertEqual(rc, 0)
        hashes = self.assert_output_manifest(out)
        expected = {"proposition_generator.jsonl", "proposition_verifier.jsonl", "checkpoint.jsonl",
                    "stage_journal.jsonl", "failures.jsonl", "audit_sample_manifest.json"}
        expected.update(f"validated_route_queues/{route}.jsonl" for route in C.PRIMARY_ROUTES)
        for call in ("000001_generator", "000002_verifier"):
            expected.update(f"calls/{call}/{name}" for name in ("request_body.bin", "response_body.bin", "journal.jsonl"))
        self.assertEqual(set(hashes), expected)
        for route in C.PRIMARY_ROUTES:
            self.assertEqual(hashes[f"validated_route_queues/{route}.jsonl"], hashlib.sha256(b"").hexdigest())
        gen = out / "proposition_generator.jsonl"
        rc, _, out = self.reverify(gen)
        self.assertEqual(rc, 0)
        hashes = self.assert_output_manifest(out)
        expected -= {"proposition_generator.jsonl", "audit_sample_manifest.json"}
        expected = {path for path in expected if not path.startswith("calls/")}
        expected.update(f"calls/000001_verifier/{name}" for name in ("request_body.bin", "response_body.bin", "journal.jsonl"))
        self.assertEqual(set(hashes), expected)
        job = json.loads((out / "job_record.json").read_text())
        self.assertEqual(job["generator_jsonl_sha256"], C.sha256_file(str(gen)))

    def test_failed_output_manifest_covers_incomplete_response_and_retains_failed_terminal(self):
        self.coverage = [record(), record("W000002")]
        self.save_sources()
        response = Response(b"")
        partial = b'{"model":"expected-model",'
        response.read = mock.Mock(side_effect=http.client.IncompleteRead(partial, 50))
        self.opener.return_value = response
        self.opener.side_effect = None
        rc, report, out = self.run_main()
        self.assertEqual(rc, 1)
        self.assert_failed(report)
        self.assertEqual(self.opener.call_count, 1)
        self.assertEqual(report["unattempted_window_ids"], ["W000002"])
        hashes = self.assert_output_manifest(out)
        self.assertEqual(hashes["calls/000001_generator/response_body.bin"], hashlib.sha256(partial).hexdigest())
        self.assertEqual(C.read_jsonl(str(out / "stage_journal.jsonl"))[-1]["status"], "failed")
        self.assertTrue(C.read_jsonl(str(out / "failures.jsonl")))
        self.assertEqual(json.loads((out / "job_record.json").read_text())["status"], "failed")

    def test_valid_negative_verdicts_are_normal_completed_results(self):
        for overall in ("insufficient_evidence", "contradicted", "abstain"):
            self.dispatch([card()], lambda cid: verdict(cid, overall))
            rc, report, out = self.run_main(overall)
            self.assertEqual(rc, 0)
            self.assertTrue(report["ok"])
            self.assertTrue(report["generation_complete"])
            self.assertTrue(report["verification_complete"])
            self.assertEqual(report["cards_valid"], 1)
            self.assertEqual(report["contract_errors"], 0)
            self.assertFalse(report["quality_certified"])
            self.assertFalse(any(p.read_text() for p in (out / "validated_route_queues").iterdir()))

    def test_interrupted_verifier_persists_failed_terminal_and_proposal_evidence(self):
        self.coverage = [record(), record("W000002")]
        self.save_sources()
        self.opener.side_effect = [Response(envelope(json.dumps({"propositions": [card(), card()]}))),
                                   Response(envelope("not parsed"), KeyboardInterrupt())]
        rc, report, out = self.run_main()
        self.assertEqual(rc, 1)
        self.assert_failed(report)
        self.assertEqual(report["cards_unusable"], 1)
        self.assertEqual(report["cards_unattempted"], 1)
        self.assertEqual(self.opener.call_count, 2)
        self.assertTrue((out / "calls/000002_verifier/response_body.bin").exists())
        journal = C.read_jsonl(str(out / "stage_journal.jsonl"))
        self.assertTrue(any(row.get("proposal", {}).get("cards") for row in journal))
        self.assertEqual(journal[-1]["status"], "failed")
        self.assertEqual((out / "checkpoint.jsonl").read_bytes(), b"")

    def original(self):
        self.dispatch([card()])
        rc, report, out = self.run_main("original")
        self.assertEqual(rc, 0)
        self.opener.reset_mock()
        return out, out / "proposition_generator.jsonl"

    def reverify(self, gen, name="reverify", extra=()):
        return self.run_main(name, ("--verifier-only", "--gen-jsonl", str(gen), *extra))

    def test_reverify_offline_bindings_and_persisted_source_hashes(self):
        original, gen = self.original()
        self.opener.side_effect = AssertionError("dry-run must stay offline")
        rc, _, out = self.reverify(gen, extra=("--dry-run",))
        self.assertEqual(rc, 0)
        self.assertFalse(out.exists())
        self.opener.assert_not_called()
        self.dispatch()
        rc, report, out = self.reverify(gen)
        self.assertEqual(rc, 0)
        self.assertEqual(report["mode"], "verifier_only_reverify")
        self.assertEqual(report["generator_attempts"], 0)
        self.assertEqual(self.opener.call_count, 1)
        self.assertEqual(report["source_generator_jsonl_sha256"], C.sha256_file(str(gen)))
        job = json.loads((out / "job_record.json").read_text())
        self.assertEqual(job["source_bindings"], report["source_bindings"])
        self.assertEqual(job["generator_jsonl_sha256"], report["source_generator_jsonl_sha256"])

    def test_bad_generation_cannot_be_reverified_as_empty_completed_work(self):
        for index, content in enumerate(("not-json", '{"propositions":{}}', '{"propositions":[],"unknown":0}',
                                         '{"propositions":[],"propositions":[]}')):
            self.opener.side_effect = [Response(envelope(content))]
            rc, report, original = self.run_main(f"bad-generator-{index}")
            self.assertEqual(rc, 1)
            self.assert_failed(report)
            self.opener.reset_mock()
            for extra in ((), ("--dry-run",)):
                with self.subTest(index=index, extra=extra), self.assertRaisesRegex(SystemExit, "original_generator"):
                    self.reverify(original / "proposition_generator.jsonl", f"bad-reverify-{index}", extra)
                self.assertFalse((self.root / f"bad-reverify-{index}").exists())
            self.opener.assert_not_called()

    def test_reverify_validates_generator_meta_raw_envelope_and_card_correspondence(self):
        original, gen = self.original()
        baseline = C.read_jsonl(str(gen))
        variants = []
        for key, value in (("http_status", 500), ("http_status", 200.0), ("finish_reason", "length"),
                           ("model", "another-model"), ("error", "transport"), ("error", ""),
                           ("response_incomplete", True)):
            row = copy.deepcopy(baseline[0])
            row["call_meta"][key] = value
            variants.append(row)
        row = copy.deepcopy(baseline[0])
        del row["call_meta"]["error"]
        variants.append(row)
        for key, value in (("call_meta", None), ("model_parse_ok", False), ("model_parse_ok", 1),
                           ("parse_error", "invalid_json"), ("proposed_count", 0), ("proposed_count", True),
                           ("cards", []), ("raw_response", "not-json"),
                           ("raw_response", '{"propositions":[],"extra":0}'),
                           ("raw_response", '{"propositions":[],"propositions":[]}'),
                           ("raw_response", json.dumps({"propositions": [card()] * 4}))):
            variants.append({**copy.deepcopy(baseline[0]), key: value})
        for raw_card in ({**card(), "proposition_text": "not the stored proposal"},
                         {**card(), "evidence_spans": [{"sentence_id": SID, "start": False, "end": 29}]}):
            variants.append({**copy.deepcopy(baseline[0]), "raw_response": json.dumps({"propositions": [raw_card]})})
        for index, row in enumerate(variants):
            gen.write_text(json.dumps(row) + "\n", encoding="utf-8")
            for extra in ((), ("--dry-run",)):
                with self.subTest(index=index, extra=extra), self.assertRaisesRegex(SystemExit, "original_generator"):
                    self.reverify(gen, f"invalid-gen-{index}", extra)
        self.opener.assert_not_called()

    def test_schema_or_span_rejected_cards_cannot_vanish_from_reverify_denominator(self):
        for kind in ("schema", "span"):
            invalid = card()
            if kind == "schema":
                invalid["claimant_or_source"] = []
            else:
                invalid["evidence_spans"][0]["end"] = 999
            self.dispatch([card(), invalid])
            rc, report, original = self.run_main(f"rejected-{kind}")
            self.assertEqual(rc, 1)
            self.assertEqual(report["proposer_cards"], 2)
            self.assertEqual(report["cards_schema_or_span_rejected"], 1)
            self.assertEqual(report["verifier_attempts"], 0)
            self.opener.reset_mock()
            gen = original / "proposition_generator.jsonl"
            for extra in ((), ("--dry-run",)):
                with self.assertRaisesRegex(SystemExit, "original_card_schema_or_span_rejected"):
                    self.reverify(gen, f"rejected-reverify-{kind}", extra)
            rows = C.read_jsonl(str(gen))
            rows[0]["cards"].pop()
            rows[0]["proposed_count"] = 1
            gen.write_text(json.dumps(rows[0]) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(SystemExit, "original_generator_card_count_mismatch"):
                self.reverify(gen, f"dropped-card-{kind}")
            self.opener.assert_not_called()

    def test_complete_generation_with_verifier_failure_remains_repairable(self):
        self.dispatch([card(), card()], lambda cid: {**verdict(cid), "checks": []})
        rc, report, original = self.run_main("verifier-failed")
        self.assertEqual(rc, 1)
        self.assertTrue(report["generation_complete"])
        self.assertEqual(report["proposer_cards"], 2)
        self.assertEqual(report["cards_unattempted"], 1)
        self.opener.reset_mock()
        self.dispatch()
        rc, report, _ = self.reverify(original / "proposition_generator.jsonl", extra=("--dry-run",))
        self.assertEqual(rc, 0)
        self.opener.assert_not_called()
        rc, report, _ = self.reverify(original / "proposition_generator.jsonl")
        self.assertEqual(rc, 0)
        self.assertEqual(report["proposer_cards"], 2)
        self.assertEqual(report["cards_valid"], 2)
        self.assertEqual(report["generator_attempts"], 0)
        self.assertEqual(report["verifier_attempts"], 2)

    def test_partial_generation_cannot_be_repaired_by_verifier_only(self):
        self.coverage = [record(), record("W000002")]
        self.save_sources()
        self.dispatch([card()], lambda cid: {**verdict(cid), "checks": []})
        rc, _, original = self.run_main("partial")
        self.assertEqual(rc, 1)
        self.opener.reset_mock()
        for extra in ((), ("--dry-run",)):
            with self.assertRaisesRegex(SystemExit, "original_requested_windows_missing"):
                self.reverify(original / "proposition_generator.jsonl", extra=extra)
        self.opener.assert_not_called()

    def test_job_window_count_and_generator_model_must_match_original_rows(self):
        original, gen = self.original()
        job_path = original / "job_record.json"
        baseline = json.loads(job_path.read_text())
        for index, changes in enumerate(({"total_windows": 2}, {"total_windows": True},
                                         {"model": "not-the-generator-model"}, {"model": None})):
            job_path.write_text(json.dumps({**baseline, **changes}), encoding="utf-8")
            for extra in ((), ("--dry-run",)):
                with self.subTest(changes=changes, extra=extra), self.assertRaisesRegex(SystemExit, "original_generator"):
                    self.reverify(gen, f"job-binding-{index}", extra)
        self.opener.assert_not_called()

    def test_reverify_wrong_book_colliding_ids_changed_sources_and_missing_windows_predispatch(self):
        original, gen = self.original()
        original_bytes = gen.read_bytes()
        job_path = original / "job_record.json"
        job_bytes = job_path.read_bytes()
        job = json.loads(job_bytes)
        rows = C.read_jsonl(str(gen))
        variants = []
        wrong_book = copy.deepcopy(job)
        wrong_book["book"] = "another-book"
        variants.append((wrong_book, rows))
        for level, key, value in (("row", "allowed_work_ids", ["another-book"]),
                                  ("row", "work_id", "another-book"),
                                  ("row", "chapter_id", "B002:C0001"),
                                  ("row", "sentence_ids", [SID2]),
                                  ("card", "work_id", "another-book"),
                                  ("card", "allowed_work_ids", ["another-book"]),
                                  ("card", "accepted_for_verification", False),
                                  ("card", "window_id", "missing"),
                                  ("card", "chapter_id", "B002:C0001")):
            altered = copy.deepcopy(rows)
            target = altered[0] if level == "row" else altered[0]["cards"][0]
            target[key] = value
            variants.append((job, altered))
        duplicate_card = copy.deepcopy(rows)
        duplicate_card[0]["cards"].append(copy.deepcopy(duplicate_card[0]["cards"][0]))
        variants.extend(((job, rows * 2), (job, duplicate_card), (job, [])))
        altered = copy.deepcopy(rows)
        altered[0]["cards"][0]["normalized_card"]["proposition_text"] = "mutated"
        variants.append((job, altered))
        for index, (job_value, gen_rows) in enumerate(variants):
            job_path.write_text(json.dumps(job_value), encoding="utf-8")
            gen.write_text("".join(json.dumps(row) + "\n" for row in gen_rows), encoding="utf-8")
            for extra in ((), ("--dry-run",)):
                with self.subTest(index=index, extra=extra), self.assertRaisesRegex(SystemExit, "predispatch"):
                    self.reverify(gen, f"bad-{index}", extra)
        gen.write_bytes(original_bytes)
        job_path.write_bytes(job_bytes)
        self.sources[0]["text"] += " mutated source"
        self.save_sources()
        for extra in ((), ("--dry-run",)):
            with self.assertRaisesRegex(SystemExit, "original_source_hash_mismatch"):
                self.reverify(gen, extra=extra)
        self.opener.assert_not_called()

    def test_reverify_coverage_mutation_and_missing_original_job_fail_offline(self):
        original, gen = self.original()
        self.coverage[0]["role"] = "other"
        self.save_sources()
        with self.assertRaisesRegex(SystemExit, "original_source_hash_mismatch"):
            self.reverify(gen, extra=("--dry-run",))
        self.coverage[0]["role"] = "rule_atom_read"
        self.save_sources()
        (original / "job_record.json").unlink()
        with self.assertRaisesRegex(SystemExit, "predispatch"):
            self.reverify(gen, extra=("--dry-run",))
        self.opener.assert_not_called()

    def test_generator_mutation_during_reverify_cannot_complete(self):
        original, gen = self.original()
        self.dispatch()
        normal_opener = self.opener.side_effect

        def mutate(request, timeout):
            result = normal_opener(request, timeout)
            gen.write_bytes(gen.read_bytes() + b"\n")
            return result

        self.opener.side_effect = mutate
        rc, report, _ = self.reverify(gen)
        self.assertEqual(rc, 1)
        self.assert_failed(report)
        self.assertEqual(report["terminal_failure"]["errors"], ["generator_changed_during_reverify"])
        self.assertNotEqual(report["source_generator_jsonl_sha256"], C.sha256_file(str(gen)))


if __name__ == "__main__":
    unittest.main()
