"""Offline explicit-selection regressions; every artifact is a temporary fixture."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import shutil
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("effective_selection_test", ROOT / "tools/select_effective_verification.py")
S = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(S)
SID = "B001:C0001:S000001"
SID2 = "B001:C0001:S000002"
WORK = "fixture-book"
CID = "W1#0"
MODEL = "fixture-model"
GEN_PROMPT = "Generate propositions from the supplied fixture source."
VER_PROMPT = "Verify this fixture candidate against its literal evidence."


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=True), encoding="utf-8")


def write_rows(path, rows):
    path.write_text("".join(json.dumps(row, ensure_ascii=True) + "\n" for row in rows), encoding="utf-8")


def ref(path):
    return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.original = self.root / "original"
        self.reverify = self.root / "another-attempt"
        self.original.mkdir()
        self.reverify.mkdir()
        self.coverage = self.root / "coverage.jsonl"
        self.sentences = self.root / "sentences.jsonl"
        self.gen = self.original / "proposition_generator.jsonl"
        self.job = self.original / "job_record.json"
        self.ver = self.original / "proposition_verifier.jsonl"
        self.rver = self.reverify / "proposition_verifier.jsonl"
        self.rjob = self.reverify / "job_record.json"
        self.selection = self.root / "decision.json"
        self.out = self.root / "new-view"
        write_rows(self.coverage, [{"window_id": "W1", "chapter_id": "B001:C0001", "work_id": WORK,
                                   "role": "rule_atom_read", "anchor_sentence_ids": [SID, SID2],
                                   "attached_sentence_ids": []}])
        write_rows(self.sentences, [{"sentence_id": sid, "chapter_id": "B001:C0001", "work_id": WORK,
                                    "text": text} for sid, text in
                                   ((SID, "The gate opens. A different claim."), (SID2, "Not supplied to verifier."))])
        self.card = {"primary_route": "bounded_event", "proposition_text": "The gate opens.",
                     "evidence_ids": [SID], "evidence_spans": [{"sentence_id": SID, "start": 0, "end": 15}],
                     "assertion_status": "narrator_asserted", "temporal_status": "bounded_occurrence",
                     "evidence_directness": "explicit", "content_facets": ["bounded_event"],
                     "generality_scope": "instance", "claimant_or_source": None}
        self.item = {"card_id": CID, "work_id": WORK, "window_id": "W1", "chapter_id": "B001:C0001",
                     "allowed_work_ids": [WORK], "route": "bounded_event", "accepted_for_verification": True,
                     "generator_card": copy.deepcopy(self.card), "normalized_card": copy.deepcopy(self.card)}
        self.grow = {"window_id": "W1", "work_id": WORK, "chapter_id": "B001:C0001",
                     "allowed_work_ids": [WORK], "sentence_ids": [SID, SID2], "cards": [self.item],
                     "raw_response": json.dumps({"propositions": [self.card]}), "proposed_count": 1,
                     "model_parse_ok": True, "parse_error": None, "prompt_sha256": S.C.sha256_text(GEN_PROMPT),
                     "call_meta": {"http_status": 200, "model": MODEL, "finish_reason": "stop", "error": None,
                                   "capture_dir": "calls/000001_generator"}}
        self.grow["call_meta"]["content_sha256"] = S.C.sha256_text(self.grow["raw_response"])
        write_rows(self.gen, [self.grow])
        self.job_data = {"book": WORK, "generator_reused": False, "acceptance_contract_version": 2,
                         "model": MODEL, "verifier_model": MODEL, "ok": True, "input_artifact_hashes": {
                             "coverage_partition.jsonl": ref(self.coverage)["sha256"],
                             "sentences.jsonl": ref(self.sentences)["sha256"]}}
        write_json(self.job, self.job_data)
        self.rjob_data = {**copy.deepcopy(self.job_data), "generator_reused": True,
                          "generator_jsonl": str(self.gen), "generator_jsonl_sha256": ref(self.gen)["sha256"],
                          "source_generator_jsonl": str(self.gen),
                          "source_generator_jsonl_sha256": ref(self.gen)["sha256"],
                          "source_book": WORK, "source_bindings": self.job_data["input_artifact_hashes"]}
        write_json(self.rjob, self.rjob_data)
        self.vrow = self.verifier_row()
        write_rows(self.ver, [self.vrow])
        write_rows(self.rver, [self.vrow])
        self.seal_outputs(self.original)
        self.seal_outputs(self.reverify)
        self.job_data = json.loads(self.job.read_text())
        self.rjob_data = json.loads(self.rjob.read_text())
        self.entry = {"work_id": WORK, "card_id": CID, "attempt_kind": "original",
                      "candidate_sha256": S.candidate_sha256(self.card), "generator": ref(self.gen),
                      "generator_job": ref(self.job), "verifier": ref(self.ver), "verifier_job": ref(self.job),
                      "coverage": ref(self.coverage), "sentences": ref(self.sentences)}
        self.network = mock.patch.object(S.C, "call_model", side_effect=AssertionError("model call forbidden"))
        self.network.start()
        self.addCleanup(self.network.stop)
        self.http = mock.patch.object(S.C.urllib.request.OpenerDirector, "open",
                                      side_effect=AssertionError("network forbidden"))
        self.http.start()
        self.addCleanup(self.http.stop)

    def verifier_row(self, overall="entailed"):
        payload = {"case_id": f"{WORK}|W1|{CID}", "overall": overall, "no_runtime_effect": True,
                   "checks": [{"field_path": field, "verdict": overall, "evidence_ids": [SID],
                               "reason": "Bound to the supplied literal evidence."}
                              for field in S.C.REQUIRED_VERIFIER_FIELDS]}
        raw = "<VERDICT_JSON>" + json.dumps(payload) + "</VERDICT_JSON>"
        return {**copy.deepcopy(self.item), "entailed": True,
                "verifier": {"verdict": "entailed", "contract_overall": "entailed", "errors": [],
                             "prompt_sha256": S.C.sha256_text(VER_PROMPT),
                             "raw_response": raw, "call_meta": {"http_status": 200, "model": MODEL,
                             "finish_reason": "stop", "error": None, "content_sha256": S.C.sha256_text(raw),
                             "capture_dir": "calls/000002_verifier"}}}

    def choose_reverify(self):
        self.entry.update(attempt_kind="reverify", verifier=ref(self.rver), verifier_job=ref(self.rjob))

    def decision(self, entries=None):
        write_json(self.selection, {"schema_version": 1, "entries": entries if entries is not None else [self.entry]})
        return ref(self.selection)["sha256"]

    def validate(self, materialize=False, entries=None):
        return S.validate_selection(self.selection, self.decision(entries), self.out, materialize=materialize)

    def seal_outputs(self, directory):
        """Publish a synthetic attempt's outputs, not merely decision pins."""
        for filename, stage, prompt in (("proposition_generator.jsonl", "generator", GEN_PROMPT),
                                        ("proposition_verifier.jsonl", "verifier", VER_PROMPT)):
            path = directory / filename
            if not path.exists():
                continue
            for row in [json.loads(line) for line in path.read_text().splitlines() if line.strip()]:
                call = row if stage == "generator" else row.get("verifier")
                if not isinstance(call, dict) or not isinstance(call.get("call_meta"), dict):
                    continue
                capture = call["call_meta"].get("capture_dir")
                if not capture:
                    continue
                folder = directory / capture
                folder.mkdir(parents=True, exist_ok=True)
                request = folder / "request_body.bin"
                response = folder / "response_body.bin"
                write_json(request, {"model": MODEL, "messages": [{"role": "user", "content": prompt}]})
                write_json(response, {"model": MODEL, "choices": [{"finish_reason": "stop",
                                       "message": {"content": call.get("raw_response")}}]})
                write_rows(folder / "journal.jsonl", [
                    {"stage": "request_saved", "sha256": ref(request)["sha256"]},
                    {"stage": "response_saved", "http_status": 200, "sha256": ref(response)["sha256"]},
                    {"stage": "envelope_validated", "error": None}])
        job_path = directory / "job_record.json"
        job = json.loads(job_path.read_text())
        job["output_file_hashes"] = {p.relative_to(directory).as_posix(): ref(p)["sha256"]
                                     for p in directory.rglob("*") if p.is_file()
                                     and p.name not in ("job_record.json", "validation_report.json")}
        write_json(job_path, job)

    def refresh(self, *, seal=True):
        if seal:
            for directory in {Path(self.entry[key]["path"]).parent for key in ("generator_job", "verifier_job")}:
                self.seal_outputs(directory)
        for key in S.ARTIFACTS:
            self.entry[key] = ref(Path(self.entry[key]["path"]))

    def store_capture_paths(self, generator, verifier):
        """Change published metadata without rewriting any captured bytes."""
        grow, vrow = copy.deepcopy(self.grow), copy.deepcopy(self.vrow)
        grow["call_meta"]["capture_dir"] = generator
        vrow["verifier"]["call_meta"]["capture_dir"] = verifier
        write_rows(self.gen, [grow])
        write_rows(self.ver, [vrow])
        job = copy.deepcopy(self.job_data)
        for path in (self.gen, self.ver):
            job["output_file_hashes"][path.name] = ref(path)["sha256"]
        write_json(self.job, job)
        self.refresh(seal=False)

    def assert_rejected(self, reason=None, entries=None):
        with self.assertRaises((ValueError, OSError)) as caught:
            self.validate(materialize=True, entries=entries)
        if reason:
            self.assertIn(reason, str(caught.exception))
        self.assertFalse(self.out.exists())

    def test_explicit_original_and_reverify_materialize_pinned_review_views(self):
        for kind in ("original", "reverify"):
            with self.subTest(kind=kind):
                if kind == "reverify":
                    self.choose_reverify()
                    self.out = self.root / "second-view"
                before = {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
                rows, report = self.validate(materialize=True)
                self.assertEqual(rows[0]["effective_status"], "entailed")
                self.assertEqual(rows[0]["attempt_kind"], kind)
                self.assertEqual(rows[0]["evidence_block"], f"{SID}|The gate opens.")
                self.assertEqual(rows[0]["verifier_line"], 1)
                self.assertEqual(rows[0]["selection"]["sha256"], ref(self.selection)["sha256"])
                for key in S.ARTIFACTS:
                    self.assertEqual(rows[0][key], self.entry[key])
                for artifact in (rows[0], report):
                    self.assertTrue(artifact["no_runtime_effect"])
                    self.assertFalse(artifact["quality_certified"])
                    self.assertFalse(artifact["cross_work_merge"])
                queue = self.out / "entailed_REVIEW_queues/bounded_event.jsonl"
                self.assertEqual(json.loads(queue.read_text(encoding="utf-8")), rows[0])
                self.assertEqual(len(list((self.out / "entailed_REVIEW_queues").glob("*.jsonl"))), len(S.C.PRIMARY_ROUTES))
                self.assertEqual(json.loads((self.out / "reconciliation_report.json").read_text()), report)
                for path, data in before.items():
                    if path != self.selection:
                        self.assertEqual(path.read_bytes(), data)

    def test_original_positive_never_overrides_explicit_negative_or_abstain(self):
        self.choose_reverify()
        for overall in ("insufficient_evidence", "contradicted", "abstain"):
            with self.subTest(overall=overall):
                write_rows(self.rver, [self.verifier_row(overall)])
                self.refresh()
                self.out = self.root / overall
                rows, report = self.validate(materialize=True)
                self.assertEqual(rows[0]["effective_status"], overall)
                self.assertEqual(rows[0]["contract_overall"], overall)
                self.assertEqual(report["entailed_review_queue_counts"]["bounded_event"], 0)
                self.assertEqual((self.out / "entailed_REVIEW_queues/bounded_event.jsonl").read_bytes(), b"")

    def test_explicit_original_negative_ignores_positive_reverify(self):
        write_rows(self.ver, [self.verifier_row("insufficient_evidence")])
        self.refresh()
        rows, _ = self.validate()
        self.assertEqual(rows[0]["effective_status"], "insufficient_evidence")
        self.assertEqual(rows[0]["attempt_kind"], "original")

    def test_selected_missing_failed_and_invalid_rows_are_unverified_no_fallback(self):
        self.choose_reverify()
        failed = self.verifier_row()
        failed["verifier"]["call_meta"]["error"] = "http_503"
        malformed = self.verifier_row()
        malformed["verifier"]["raw_response"] = "not JSON"
        missing = copy.deepcopy(self.item)
        missing.pop("normalized_card")
        null_card = {**copy.deepcopy(self.vrow), "normalized_card": None}
        for chosen in ([], [failed], [malformed], [missing], [null_card]):
            with self.subTest(chosen=chosen):
                write_rows(self.rver, chosen)
                self.refresh()
                rows, report = self.validate()
                self.assertEqual(rows[0]["effective_status"], "unverified")
                self.assertTrue(rows[0]["reasons"])
                self.assertEqual(report["effective_status_counts"], {"unverified": 1})

    def test_old_ok_and_missing_or_empty_checks_never_certify(self):
        self.choose_reverify()
        for version in (None, 1, True, "2"):
            job = {**self.rjob_data, "acceptance_contract_version": version, "ok": True}
            write_json(self.rjob, job)
            self.refresh()
            rows, _ = self.validate()
            self.assertEqual(rows[0]["effective_status"], "unverified")
            self.assertIn("explicit_acceptance_contract_v2_required", rows[0]["reasons"])
        write_json(self.rjob, self.rjob_data)
        for checks in (None, [], "missing"):
            chosen = self.verifier_row()
            payload = json.loads(chosen["verifier"]["raw_response"].split("<VERDICT_JSON>")[1].split("</VERDICT_JSON>")[0])
            if checks == "missing":
                del payload["checks"]
            else:
                payload["checks"] = checks
            self.save_payload(chosen, payload)
            self.refresh()
            rows, _ = self.validate()
            self.assertEqual(rows[0]["effective_status"], "unverified")
            self.assertIn("checks_required", rows[0]["reasons"])

    def save_payload(self, chosen, payload):
        raw = "<VERDICT_JSON>" + json.dumps(payload) + "</VERDICT_JSON>"
        chosen["verifier"]["raw_response"] = raw
        chosen["verifier"]["call_meta"]["content_sha256"] = S.C.sha256_text(raw)
        write_rows(self.rver, [chosen])

    def test_strict_parser_sees_only_candidate_citations_and_exact_spans(self):
        self.choose_reverify()
        chosen = self.verifier_row()
        payload = {"case_id": f"{WORK}|W1|{CID}", "overall": "entailed", "no_runtime_effect": True,
                   "checks": [{"field_path": field, "verdict": "entailed", "evidence_ids": [SID2],
                               "reason": "Outside actual supplied candidate evidence."}
                              for field in S.C.REQUIRED_VERIFIER_FIELDS]}
        self.save_payload(chosen, payload)
        self.refresh()
        with mock.patch.object(S.C, "parse_verifier_card", wraps=S.C.parse_verifier_card) as parser:
            rows, _ = self.validate()
        self.assertEqual(parser.call_count, 1)
        self.assertEqual(rows[0]["effective_status"], "unverified")
        self.assertIn("cited_outside_sent_card_evidence", rows[0]["reasons"])
        self.assertNotIn("different claim", rows[0]["evidence_block"])

    def test_changed_generator_or_source_bytes_rejected(self):
        for path in (self.gen, self.coverage, self.sentences, self.job, self.ver):
            with self.subTest(path=path):
                original = path.read_bytes()
                path.write_bytes(original + b"\n")
                self.assert_rejected("artifact_hash_mismatch")
                path.write_bytes(original)

    def test_repinning_mutated_sources_still_rejects_original_job_binding(self):
        self.sentences.write_bytes(self.sentences.read_bytes() + b"\n")
        self.refresh()
        self.assert_rejected("job_source_hash_mismatch")

    def test_repinning_generator_cannot_reuse_attempt_bound_to_old_snapshot(self):
        self.choose_reverify()
        self.gen.write_bytes(self.gen.read_bytes() + b"\n")
        self.refresh()
        self.assert_rejected("reverify_generator_hash_mismatch")

    def test_reverify_wrong_generator_hash_or_path_or_source_binding_rejected(self):
        self.choose_reverify()
        mutations = ({"generator_jsonl_sha256": "0" * 64}, {"generator_jsonl": str(self.root / "wrong")},
                     {"source_generator_jsonl_sha256": "0" * 64}, {"source_book": "other"},
                     {"source_bindings": {}}, {"generator_reused": False})
        for changes in mutations:
            with self.subTest(changes=changes):
                write_json(self.rjob, {**self.rjob_data, **changes})
                self.refresh()
                self.assert_rejected()

    def test_wrong_work_with_colliding_ids_rejected_at_every_join(self):
        for target in ("entry", "job", "generator", "card", "verifier", "coverage", "sentence"):
            with self.subTest(target=target):
                originals = {p: p.read_bytes() for p in (self.gen, self.job, self.ver, self.coverage, self.sentences)}
                if target == "entry":
                    self.entry["work_id"] = "another-work"
                elif target == "job":
                    write_json(self.job, {**self.job_data, "book": "another-work"})
                elif target in ("generator", "card"):
                    grow = copy.deepcopy(self.grow)
                    obj = grow if target == "generator" else grow["cards"][0]
                    obj["work_id"] = "another-work"
                    write_rows(self.gen, [grow])
                elif target == "verifier":
                    write_rows(self.ver, [{**self.vrow, "work_id": "another-work"}])
                else:
                    path = self.coverage if target == "coverage" else self.sentences
                    records = [json.loads(line) for line in path.read_text().splitlines()]
                    records[0]["work_id"] = "another-work"
                    write_rows(path, records)
                    job = copy.deepcopy(self.job_data)
                    job["input_artifact_hashes"]["coverage_partition.jsonl" if target == "coverage" else "sentences.jsonl"] = ref(path)["sha256"]
                    write_json(self.job, job)
                self.refresh()
                self.assert_rejected("work_mismatch")
                self.entry["work_id"] = WORK
                for path, data in originals.items():
                    path.write_bytes(data)
                self.refresh()

    def test_duplicate_selection_including_competing_attempts_rejected(self):
        original = copy.deepcopy(self.entry)
        self.assert_rejected("duplicate_selection", [original, original])
        self.choose_reverify()
        self.assert_rejected("duplicate_selection", [original, self.entry])
        altered = {**original, "candidate_sha256": "1" * 64}
        self.assert_rejected("duplicate_selection", [original, altered])

    def test_duplicate_card_window_and_source_ids_rejected(self):
        for target in ("generator_card", "generator_window", "verifier", "coverage", "sentence"):
            with self.subTest(target=target):
                path = {"generator_card": self.gen, "generator_window": self.gen, "verifier": self.ver,
                        "coverage": self.coverage, "sentence": self.sentences}[target]
                original = path.read_bytes()
                rows = [json.loads(line) for line in path.read_text().splitlines()]
                if target == "generator_card":
                    rows[0]["cards"].append(copy.deepcopy(rows[0]["cards"][0]))
                else:
                    rows.append(copy.deepcopy(rows[0]))
                write_rows(path, rows)
                if target in ("coverage", "sentence"):
                    job = copy.deepcopy(self.job_data)
                    job["input_artifact_hashes"]["coverage_partition.jsonl" if target == "coverage" else "sentences.jsonl"] = ref(path)["sha256"]
                    write_json(self.job, job)
                self.refresh()
                self.assert_rejected("duplicate_")
                path.write_bytes(original)
                write_json(self.job, self.job_data)
                self.refresh()

    def test_candidate_window_and_normalization_mismatch_rejected(self):
        variants = []
        for mutation in ({"allowed_work_ids": [WORK, "other"]}, {"chapter_id": "B002:C0001"},
                         {"window_id": "W2"}, {"accepted_for_verification": False}):
            variants.append({**copy.deepcopy(self.item), **mutation})
        broken = copy.deepcopy(self.item)
        broken["normalized_card"]["evidence_spans"][0]["end"] = 999
        variants.append(broken)
        broken = copy.deepcopy(self.item)
        broken["generator_card"]["proposition_text"] = "Changed"
        variants.append(broken)
        for item in variants:
            write_rows(self.gen, [{**self.grow, "cards": [item]}])
            self.refresh()
            self.assert_rejected()
        write_rows(self.gen, [self.grow])
        self.refresh()
        self.entry["candidate_sha256"] = "0" * 64
        self.assert_rejected("candidate_hash_mismatch")

    def test_verifier_candidate_mismatch_rejected_not_joined_on_id_alone(self):
        for mutation in ("text", "boolean_offset", "float_offset"):
            with self.subTest(mutation=mutation):
                row = copy.deepcopy(self.vrow)
                if mutation == "text":
                    row["normalized_card"]["proposition_text"] = "Another candidate"
                else:
                    # Python equality alone conflates 0 with False and 0.0.
                    row["normalized_card"]["evidence_spans"][0]["start"] = False if mutation == "boolean_offset" else 0.0
                write_rows(self.ver, [row])
                self.refresh()
                self.assert_rejected("verifier_candidate_mismatch")

    def test_paths_pins_schema_and_original_sibling_requirements(self):
        original = copy.deepcopy(self.entry)
        for mutation in ({"path": "relative.jsonl"}, {"sha256": "bad"}, {"path": str(self.root / "missing")},
                         {"path": str(self.root / ".." / "outside")}, {"sha256": "A" * 64}):
            self.entry["generator"] = {**original["generator"], **mutation}
            self.assert_rejected()
        self.entry = copy.deepcopy(original)
        self.entry["verifier"] = ref(self.rver)
        self.entry["verifier_job"] = ref(self.rjob)
        self.assert_rejected("original_not_sibling_generator")
        self.entry = copy.deepcopy(original)
        self.entry["extra"] = True
        self.assert_rejected("bad_entry_shape")
        self.entry = original
        self.assert_rejected("explicit_entries_required", [])

    def test_manifest_pin_duplicate_keys_nonfinite_and_version_rejected(self):
        pin = self.decision()
        with self.assertRaisesRegex(ValueError, "artifact_hash_mismatch"):
            S.validate_selection(self.selection, "0" * 64, self.out)
        for text in ('{"schema_version":1,"schema_version":1,"entries":[]}',
                     '{"schema_version":NaN,"entries":[]}', '{"schema_version":true,"entries":[]}'):
            self.selection.write_text(text)
            with self.assertRaises(ValueError):
                S.validate_selection(self.selection, ref(self.selection)["sha256"], self.out)
        self.assertFalse(self.out.exists())
        self.assertNotEqual(pin, "0" * 64)

    def test_dry_run_cli_no_writes_and_materialize_absent_only(self):
        pin = self.decision()
        args = ["--selection", str(self.selection), "--selection-sha256", pin, "--out-dir", str(self.out)]
        before = {str(p.relative_to(self.root)): p.read_bytes() if p.is_file() else None
                  for p in self.root.rglob("*")}
        with redirect_stdout(io.StringIO()) as output:
            self.assertEqual(S.main(args), 0)
        self.assertTrue(json.loads(output.getvalue())["dry_run"])
        after = {str(p.relative_to(self.root)): p.read_bytes() if p.is_file() else None
                 for p in self.root.rglob("*")}
        self.assertEqual(before, after)
        with redirect_stdout(io.StringIO()):
            self.assertEqual(S.main(args + ["--materialize"]), 0)
        snapshot = {str(p): p.read_bytes() for p in self.out.rglob("*") if p.is_file()}
        for suffix in ([], ["--materialize"]):
            with redirect_stderr(io.StringIO()):
                self.assertEqual(S.main(args + suffix), 2)
        self.assertEqual(snapshot, {str(p): p.read_bytes() for p in self.out.rglob("*") if p.is_file()})
        with self.assertRaises(ValueError):
            S.validate_selection(self.selection, pin, "relative-output")
        with self.assertRaises(ValueError):
            S.validate_selection(self.selection, pin, self.root / "missing-parent" / "output", materialize=True)
        self.assertFalse((self.root / "missing-parent").exists())

    def test_unselected_inventory_is_not_implied_accepted_or_reparsed(self):
        other = {**copy.deepcopy(self.item), "card_id": "W1#1", "normalized_card": None}
        grow = copy.deepcopy(self.grow)
        grow.update(cards=[self.item, other], proposed_count=2,
                    raw_response=json.dumps({"propositions": [self.card, self.card]}))
        grow["call_meta"]["content_sha256"] = S.C.sha256_text(grow["raw_response"])
        write_rows(self.gen, [grow])
        write_rows(self.ver, [self.vrow, {**copy.deepcopy(self.vrow), "card_id": "W1#1",
                                        "verifier": {"raw_response": "do not parse this historical output"}}])
        self.refresh()
        with mock.patch.object(S.C, "parse_verifier_card", wraps=S.C.parse_verifier_card) as parser:
            rows, report = self.validate()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["effective_status"], "entailed")
        self.assertEqual(parser.call_count, 1)
        self.assertEqual(report["unselected_cards"][0]["card_id"], "W1#1")
        self.assertFalse(report["unselected_cards"][0]["implied_accepted"])
        self.assertFalse(report["unselected_implied_accepted"])

    def test_generator_row_source_ids_and_verifier_window_are_bound(self):
        for change in ({"sentence_ids": [SID]}, {"sentence_ids": [SID2, SID]},
                       {"chapter_id": "B002:C0001"}):
            write_rows(self.gen, [{**self.grow, **change}])
            self.refresh()
            self.assert_rejected("generator_row_source_binding_mismatch")
        write_rows(self.gen, [self.grow])
        write_rows(self.ver, [{**self.vrow, "window_id": "unrelated"}])
        self.refresh()
        self.assert_rejected("card_window_binding_mismatch")

    def test_conflicting_path_pins_and_missing_verifier_file_fail_without_writes(self):
        self.entry["verifier_job"]["sha256"] = "0" * 64
        self.assert_rejected("conflicting_path_pins")
        self.entry["verifier_job"] = ref(self.job)
        self.ver.unlink()
        self.assert_rejected()

    def test_validation_detects_concurrent_input_changes_before_writing(self):
        parser = S.C.parse_verifier_card

        def mutate(*args, **kwargs):
            self.gen.write_bytes(self.gen.read_bytes() + b"\n")
            return parser(*args, **kwargs)

        with mock.patch.object(S.C, "parse_verifier_card", side_effect=mutate):
            self.assert_rejected("artifact_changed_during_validation")

    def test_two_works_with_same_local_ids_are_kept_separate(self):
        original = copy.deepcopy(self.entry)
        other_root = self.root / "other-work"
        other_root.mkdir()
        for key in S.ARTIFACTS:
            old = Path(self.entry[key]["path"])
            new = other_root / old.name
            new.write_text(old.read_text().replace(WORK, "other-work"), encoding="utf-8")
            self.entry[key] = ref(new)
        other_job = json.loads(Path(self.entry["generator_job"]["path"]).read_text())
        other_job["input_artifact_hashes"] = {"coverage_partition.jsonl": self.entry["coverage"]["sha256"],
                                             "sentences.jsonl": self.entry["sentences"]["sha256"]}
        write_json(Path(self.entry["generator_job"]["path"]), other_job)
        self.entry["generator_job"] = ref(Path(self.entry["generator_job"]["path"]))
        self.entry["verifier_job"] = self.entry["generator_job"]
        other_ver = json.loads(Path(self.entry["verifier"]["path"]).read_text())
        other_ver["verifier"]["call_meta"]["content_sha256"] = S.C.sha256_text(other_ver["verifier"]["raw_response"])
        write_rows(Path(self.entry["verifier"]["path"]), [other_ver])
        self.entry["verifier"] = ref(Path(self.entry["verifier"]["path"]))
        self.entry["work_id"] = "other-work"
        self.refresh()
        rows, _ = self.validate(entries=[original, self.entry])
        self.assertEqual([row["work_id"] for row in rows], [WORK, "other-work"])
        self.assertEqual([row["card_id"] for row in rows], [CID, CID])
        self.assertTrue(all(row["effective_status"] == "entailed" for row in rows))
        self.assertEqual([row["allowed_work_ids"] for row in rows], [[WORK], ["other-work"]])

    def test_canonical_candidate_hash_rule(self):
        value = {"z": "\u4e16\u754c", "a": [1, True, None]}
        canonical = b'{"a":[1,true,null],"z":"\\u4e16\\u754c"}'
        self.assertEqual(S.canonical_bytes(value), canonical)
        self.assertEqual(S.candidate_sha256(value), hashlib.sha256(canonical).hexdigest())
        self.assertEqual(S.candidate_sha256(value), S.candidate_sha256({"a": value["a"], "z": value["z"]}))
        with self.assertRaises(ValueError):
            S.candidate_sha256({"x": float("nan")})

    def test_failed_selected_generation_envelopes_never_select_positive(self):
        self.choose_reverify()
        mutations = ({"http_status": 503}, {"http_status": 200.0}, {"model": "wrong-model"},
                     {"finish_reason": "length"}, {"error": "failed"}, {"error": ""},
                     {"response_incomplete": True}, {"content_sha256": "0" * 64})
        for change in (*mutations, "missing_error", "missing_meta", "missing_model"):
            with self.subTest(change=change):
                grow = copy.deepcopy(self.grow)
                if change == "missing_meta":
                    del grow["call_meta"]
                elif change == "missing_error":
                    del grow["call_meta"]["error"]
                elif change == "missing_model":
                    del grow["call_meta"]["model"]
                else:
                    grow["call_meta"].update(change)
                write_rows(self.gen, [grow])
                # Publish this failed generation and bind the chosen attempt to it.
                job = {**self.rjob_data, "generator_jsonl_sha256": ref(self.gen)["sha256"],
                       "source_generator_jsonl_sha256": ref(self.gen)["sha256"]}
                write_json(self.rjob, job)
                self.refresh()
                rows, report = self.validate()
                self.assertEqual(rows[0]["effective_status"], "unverified")
                self.assertTrue(any(reason.startswith("selected_generator_") for reason in rows[0]["reasons"]))
                self.assertEqual(report["entailed_review_queue_counts"]["bounded_event"], 0)

    def test_generation_parse_status_raw_schema_counts_and_correspondence_fail_closed(self):
        variants = [{"model_parse_ok": False}, {"model_parse_ok": 1}, {"parse_error": "generator_schema"},
                    {"proposed_count": 0}, {"proposed_count": True}, {"raw_response": "not json"},
                    {"raw_response": json.dumps({"propositions": [self.card], "extra": True})},
                    {"raw_response": json.dumps({"propositions": [self.card] * 4})},
                    {"raw_response": json.dumps({"propositions": [self.card] * 2})},
                    {"raw_response": json.dumps({"propositions": [{**self.card, "proposition_text": "different"}]})},
                    {"raw_response": '{"propositions":[],"propositions":[]}'},
                    {"raw_response": '{"propositions":[NaN]}'}]
        for change in (*variants, "missing_parse_error", "missing_raw", "missing_parse_ok"):
            with self.subTest(change=change):
                grow = copy.deepcopy(self.grow)
                if isinstance(change, str):
                    del grow[{"missing_parse_error": "parse_error", "missing_raw": "raw_response",
                              "missing_parse_ok": "model_parse_ok"}[change]]
                else:
                    grow.update(change)
                if isinstance(grow.get("raw_response"), str):
                    grow["call_meta"]["content_sha256"] = S.C.sha256_text(grow["raw_response"])
                write_rows(self.gen, [grow])
                self.refresh()
                rows, report = self.validate()
                self.assertEqual(rows[0]["effective_status"], "unverified")
                self.assertTrue(any(reason.startswith("selected_generator_") for reason in rows[0]["reasons"]))
                self.assertEqual(report["entailed_review_queue_counts"]["bounded_event"], 0)

    def test_generator_card_order_and_positional_ids_are_not_inferred(self):
        second = copy.deepcopy(self.item)
        second["card_id"] = "W1#1"
        second["generator_card"]["proposition_text"] = "Another proposition."
        second["normalized_card"]["proposition_text"] = "Another proposition."
        for cards in ([second, self.item], [self.item, {**second, "card_id": "custom-id"}]):
            grow = copy.deepcopy(self.grow)
            grow.update(cards=cards, proposed_count=2,
                        raw_response=json.dumps({"propositions": [self.card, second["generator_card"]]}))
            grow["call_meta"]["content_sha256"] = S.C.sha256_text(grow["raw_response"])
            write_rows(self.gen, [grow])
            self.refresh()
            rows, _ = self.validate()
            self.assertEqual(rows[0]["effective_status"], "unverified")
            self.assertIn("selected_generator_card_correspondence_invalid", rows[0]["reasons"])

    def test_valid_selected_generation_can_repair_failed_original_book(self):
        self.choose_reverify()
        write_json(self.job, {**self.job_data, "status": "failed", "ok": False,
                             "verification_complete": False, "failures": 7,
                             "unattempted_window_ids": ["unrelated-window"]})
        self.refresh()
        rows, _ = self.validate()
        self.assertEqual(rows[0]["effective_status"], "entailed")
        self.assertEqual(rows[0]["reasons"], [])

    def test_refreshed_decision_pins_cannot_replace_job_output_hashes(self):
        for path in (self.gen, self.ver):
            with self.subTest(path=path):
                original = path.read_bytes()
                job_pin = ref(self.job)
                path.write_bytes(original + b"\n")
                self.refresh(seal=False)
                self.assert_rejected("job_output_hash_mismatch")
                self.assertEqual(ref(self.job), job_pin)
                path.write_bytes(original)
                self.refresh(seal=False)
        self.choose_reverify()
        self.rver.write_bytes(self.rver.read_bytes() + b"\n")
        self.refresh(seal=False)
        self.assert_rejected("job_output_hash_mismatch:verifier")

    def test_both_jobs_need_v2_and_historical_missing_manifest_is_unverified(self):
        self.choose_reverify()
        for path, baseline in ((self.job, self.job_data), (self.rjob, self.rjob_data)):
            for missing in ("output_file_hashes", "acceptance_contract_version"):
                with self.subTest(path=path, missing=missing):
                    job = copy.deepcopy(baseline)
                    del job[missing]
                    write_json(path, job)
                    self.refresh(seal=False)
                    rows, _ = self.validate()
                    self.assertEqual(rows[0]["effective_status"], "unverified")
                    self.assertTrue(any("manifest_missing" in reason or "v2_required" in reason
                                        for reason in rows[0]["reasons"]))
                    write_json(path, baseline)

    def test_job_manifest_paths_and_selected_file_references_are_safe(self):
        for unsafe in ("../escape", "/absolute", "C:/absolute", "calls\\bad", "./alias", "a//b", "", "a. ", "a\x00b"):
            job = copy.deepcopy(self.job_data)
            job["output_file_hashes"][unsafe] = "0" * 64
            write_json(self.job, job)
            self.refresh(seal=False)
            self.assert_rejected("unsafe_job_output_path")
        for invalid in ([], {self.gen.name: "bad"}, {}):
            write_json(self.job, {**self.job_data, "output_file_hashes": invalid})
            self.refresh(seal=False)
            self.assert_rejected()

    def test_selected_call_capture_absence_is_not_provenance(self):
        for stage in ("generator", "verifier"):
            for missing in ("capture_dir", "prompt_sha256", "capture_manifest"):
                with self.subTest(stage=stage, missing=missing):
                    grow, vrow = copy.deepcopy(self.grow), copy.deepcopy(self.vrow)
                    call = grow if stage == "generator" else vrow["verifier"]
                    if missing == "capture_dir":
                        del call["call_meta"]["capture_dir"]
                    elif missing == "prompt_sha256":
                        del call["prompt_sha256"]
                    write_rows(self.gen, [grow])
                    write_rows(self.ver, [vrow])
                    self.refresh()
                    if missing == "capture_manifest":
                        job = json.loads(self.job.read_text())
                        del job["output_file_hashes"][call["call_meta"]["capture_dir"] + "/response_body.bin"]
                        write_json(self.job, job)
                        self.refresh(seal=False)
                    rows, _ = self.validate()
                    self.assertEqual(rows[0]["effective_status"], "unverified")
                    self.assertTrue(any(reason.startswith("selected_" + stage) for reason in rows[0]["reasons"]))

    def test_selected_capture_tampering_and_semantic_mismatch_are_detected(self):
        response = self.original / "calls/000001_generator/response_body.bin"
        original = response.read_bytes()
        response.write_bytes(original + b"\n")
        self.assert_rejected("artifact_hash_mismatch")
        response.write_bytes(original)
        # Even a published capture must agree with the row and its request/journal.
        for name, value in (("request_body.bin", {"model": "wrong"}),
                            ("response_body.bin", {"model": MODEL, "choices": []}),
                            ("journal.jsonl", {"stage": "interrupted"})):
            self.seal_outputs(self.original)
            path = self.original / "calls/000001_generator" / name
            write_json(path, value)
            job = json.loads(self.job.read_text())
            job["output_file_hashes"][path.relative_to(self.original).as_posix()] = ref(path)["sha256"]
            write_json(self.job, job)
            self.refresh(seal=False)
            rows, _ = self.validate()
            self.assertEqual(rows[0]["effective_status"], "unverified")
            self.assertTrue(any(reason.startswith("selected_generator_capture") for reason in rows[0]["reasons"]))

    def test_capture_reference_cannot_escape_job(self):
        for capture in ("../elsewhere", str(self.root / "other"), "calls/000001_verifier"):
            grow = copy.deepcopy(self.grow)
            grow["call_meta"]["capture_dir"] = capture
            write_rows(self.gen, [grow])
            job = copy.deepcopy(self.job_data)
            job["output_file_hashes"][self.gen.name] = ref(self.gen)["sha256"]
            write_json(self.job, job)
            self.refresh(seal=False)
            self.assert_rejected()

    def test_moved_original_keeps_job_and_capture_bytes_with_repinned_decision_paths(self):
        formats = (
            ("relative", "", PurePosixPath),
            ("repo_posix", "runs/_extraction_scheduler/20260924/attempt/", PureWindowsPath),
            ("repo_windows", "runs\\_extraction_scheduler\\20260924\\attempt\\", PurePosixPath),
            ("windows_on_posix", "D:\\aitrpg\\worldmodel\\runs\\attempt\\", PurePosixPath),
            ("windows_slashes", "D:/aitrpg/worldmodel/runs/attempt/", PurePosixPath),
            ("wsl_on_windows", "/mnt/d/aitrpg/worldmodel/runs/attempt/", PureWindowsPath),
            ("posix", "/srv/archive/attempt/", PureWindowsPath),
            ("unc", "\\\\archive\\share\\attempt\\", PurePosixPath),
        )
        native_path = S.Path
        for label, prefix, capture_flavor in formats:
            with self.subTest(format=label):
                separator = "\\" if "\\" in prefix else "/"
                stored = [prefix + "calls" + separator + identity for identity in
                          ("000001_generator", "000002_verifier")]
                self.store_capture_paths(*stored)
                before = {p.relative_to(self.original): p.read_bytes()
                          for p in self.original.rglob("*") if p.is_file()}
                pins = {key: self.entry[key]["sha256"] for key in S.ARTIFACTS}
                old = self.original
                self.original = self.root / ("moved-" + label)
                old.rename(self.original)
                self.gen = self.original / self.gen.name
                self.ver = self.original / self.ver.name
                self.job = self.original / self.job.name
                for key in ("generator", "generator_job", "verifier", "verifier_job"):
                    self.entry[key]["path"] = str(self.original / Path(self.entry[key]["path"]).name)
                self.out = self.root / ("view-" + label)

                def simulated_path(value):
                    # Emulate the receiving OS if stored metadata ever reaches Path.
                    return capture_flavor(value) if value in stored else native_path(value)

                with mock.patch.object(S, "Path", side_effect=simulated_path) as paths:
                    rows, report = self.validate(materialize=True)
                self.assertFalse(any(call.args[0] in stored for call in paths.call_args_list))
                self.assertEqual(report["effective_status_counts"], {"entailed": 1})
                self.assertEqual(rows[0]["reasons"], [])
                self.assertEqual(rows[0]["attempt_kind"], "original")
                self.assertEqual({key: self.entry[key]["sha256"] for key in S.ARTIFACTS}, pins)
                self.assertFalse(old.exists())
                self.assertEqual(before, {p.relative_to(self.original): p.read_bytes()
                                         for p in self.original.rglob("*") if p.is_file()})
                for stage, captures in rows[0]["selected_call_captures"].items():
                    identity = "000001_generator" if stage == "generator" else "000002_verifier"
                    for name, capture in captures.items():
                        path = self.original / "calls" / identity / name
                        self.assertEqual(capture, ref(path))

    def test_unsafe_or_ambiguous_capture_identities_are_rejected(self):
        unsafe = (
            "../calls/000001_generator", "runs/../calls/000001_generator",
            "/old/../calls/000001_generator", "D:\\old\\..\\calls\\000001_generator",
            "/mnt/d/old/../calls/000001_generator", "runs/./calls/000001_generator",
            "runs//calls/000001_generator", "calls/000001_generator/",
            "calls/000001_generator/response_body.bin", "calls/calls/000001_generator",
            "/old/calls/previous/calls/000001_generator", "runs/CALLS/previous/calls/000001_generator",
            "C:\\calls\\previous\\calls\\000001_generator", "/mnt/d/calls/old/calls/000001_generator",
            "calls/000001_verifier", "calls/00001_generator", "calls/000001_generator.exe",
            "calls/000001_generator ", "calls/000001_generator.", "CALLS/000001_generator",
            "calls/000001_generator:stream", "calls/000001_generator\\..",
            "C:old/calls/000001_generator", "\\old\\calls\\000001_generator",
            "file:///old/calls/000001_generator", "https://old/calls/000001_generator",
            "//calls/000001_generator", "\\\\?\\C:\\old\\calls\\000001_generator",
            "runs/old. /calls/000001_generator",
            *("runs/bad" + char + "/calls/000001_generator" for char in ("\x00", "\n", "\t", "\x7f", "\x85")),
        )
        for capture in unsafe:
            with self.subTest(capture=capture):
                self.store_capture_paths(capture, "calls/000002_verifier")
                self.assert_rejected("unsafe_call_capture_path")

    def test_stored_absolute_capture_is_never_a_fallback_for_missing_pinned_capture(self):
        local = self.original / "calls/000001_generator"
        external = self.root / "historic/calls/000001_generator"
        shutil.copytree(local, external)
        self.store_capture_paths(str(external), "calls/000002_verifier")
        (local / "response_body.bin").unlink()
        self.assert_rejected()
        self.assertTrue((external / "response_body.bin").is_file())

    def test_full_reverify_generator_relocation_requires_explicit_mapping(self):
        self.choose_reverify()
        before = self.rjob.read_bytes()
        moved = self.root / "moved-generator"
        self.original.rename(moved)
        for key in ("generator", "generator_job"):
            self.entry[key]["path"] = str(moved / Path(self.entry[key]["path"]).name)
        self.assert_rejected("reverify_generator_path_mismatch")
        self.assertEqual(self.rjob.read_bytes(), before)

    def test_capture_relocation_preserves_exact_request_and_response_model_identity(self):
        self.store_capture_paths("D:/historic/calls/000001_generator",
                                 "/mnt/d/historic/calls/000002_verifier")
        original_job = self.job.read_bytes()
        for identity in ("000001_generator", "000002_verifier"):
            for name in ("request_body.bin", "response_body.bin"):
                with self.subTest(identity=identity, name=name):
                    self.job.write_bytes(original_job)
                    path = self.original / "calls" / identity / name
                    original = path.read_bytes()
                    body = json.loads(original)
                    body["model"] = MODEL + "-alias"
                    write_json(path, body)
                    job = json.loads(self.job.read_bytes())
                    job["output_file_hashes"][path.relative_to(self.original).as_posix()] = ref(path)["sha256"]
                    write_json(self.job, job)
                    self.refresh(seal=False)
                    rows, report = self.validate()
                    self.assertEqual(rows[0]["effective_status"], "unverified")
                    self.assertTrue(any("captured_request_mismatch" in reason or "captured_response_mismatch" in reason
                                        for reason in rows[0]["reasons"]))
                    self.assertEqual(report["entailed_review_queue_counts"]["bounded_event"], 0)
                    path.write_bytes(original)

    def test_deep_artifact_json_has_clean_cli_failure_before_any_write(self):
        deep = '{"nested":' + "[" * 10000 + "0" + "]" * 10000 + "}"
        originals = {path: path.read_bytes() for path in (self.gen, self.job)}
        entry = copy.deepcopy(self.entry)
        for target in (self.selection, self.job, self.gen):
            with self.subTest(target=target):
                for path, data in originals.items():
                    path.write_bytes(data)
                self.entry = copy.deepcopy(entry)
                target.write_text(deep, encoding="utf-8")
                if target == self.gen:
                    job = copy.deepcopy(self.job_data)
                    job["output_file_hashes"][self.gen.name] = ref(self.gen)["sha256"]
                    write_json(self.job, job)
                self.refresh(seal=False)
                pin = ref(self.selection)["sha256"] if target == self.selection else self.decision()
                args = ["--selection", str(self.selection), "--selection-sha256", pin,
                        "--out-dir", str(self.out)]
                for suffix in ([], ["--materialize"]):
                    with redirect_stderr(io.StringIO()) as error, redirect_stdout(io.StringIO()) as output:
                        self.assertEqual(S.main(args + suffix), 2)
                    self.assertEqual(error.getvalue(), "FAIL: json_nesting_too_deep\n")
                    self.assertEqual(output.getvalue(), "")
                    self.assertFalse(self.out.exists())

    def test_deep_selected_capture_and_raw_json_never_certify_or_traceback(self):
        deep = '{"nested":' + "[" * 10000 + "0" + "]" * 10000 + "}"
        for target in ("generator_raw", "verifier_raw", "request_body.bin", "response_body.bin", "journal.jsonl"):
            with self.subTest(target=target):
                grow, vrow = copy.deepcopy(self.grow), copy.deepcopy(self.vrow)
                if target == "generator_raw":
                    grow["raw_response"] = deep
                    grow["call_meta"]["content_sha256"] = S.C.sha256_text(deep)
                elif target == "verifier_raw":
                    raw = "<VERDICT_JSON>" + deep + "</VERDICT_JSON>"
                    vrow["verifier"]["raw_response"] = raw
                    vrow["verifier"]["call_meta"]["content_sha256"] = S.C.sha256_text(raw)
                write_rows(self.gen, [grow])
                write_rows(self.ver, [vrow])
                self.refresh()
                if not target.endswith("_raw"):
                    path = self.original / "calls/000001_generator" / target
                    path.write_text(deep, encoding="utf-8")
                    job = json.loads(self.job.read_bytes())
                    job["output_file_hashes"][path.relative_to(self.original).as_posix()] = ref(path)["sha256"]
                    write_json(self.job, job)
                    self.refresh(seal=False)
                args = ["--selection", str(self.selection), "--selection-sha256", self.decision(),
                        "--out-dir", str(self.out)]
                with redirect_stderr(io.StringIO()) as error, redirect_stdout(io.StringIO()) as output:
                    self.assertEqual(S.main(args), 0)
                self.assertEqual(error.getvalue(), "")
                self.assertEqual(json.loads(output.getvalue())["effective_status_counts"], {"unverified": 1})
                self.assertFalse(self.out.exists())

    def test_selected_manifest_validation_does_not_read_unrelated_outputs(self):
        job = copy.deepcopy(self.job_data)
        job["output_file_hashes"]["unrelated/missing.bin"] = "0" * 64
        write_json(self.job, job)
        self.refresh(seal=False)
        rows, report = self.validate()
        self.assertEqual(rows[0]["effective_status"], "entailed")
        self.assertIn("not the full attempt tree", report["output_validation_scope"])
        captures = rows[0]["selected_call_captures"]
        self.assertEqual(set(captures), {"generator", "verifier"})
        self.assertTrue(all(len(refs) == 3 for refs in captures.values()))


if __name__ == "__main__":
    unittest.main()
