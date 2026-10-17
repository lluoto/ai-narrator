"""Synthetic, temporary-file-only tests; no runner imports or production reads."""

import copy
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


ROOT = Path(__file__).absolute().parents[1]
SPEC = importlib.util.spec_from_file_location("efficiency_test", ROOT / "tools/report_proposition_efficiency.py")
E = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(E)
SECRET = "PRIVATE SOURCE REASONING RATIONALE DO NOT EMIT"


def write_json(path, value):
    path.write_bytes(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"))


def write_rows(path, rows):
    path.write_bytes(b"".join(json.dumps(r, ensure_ascii=False, allow_nan=False).encode("utf-8") + b"\n" for r in rows))


def ref(path):
    return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


class EfficiencyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.inventory = self.root / "inventory.json"
        self.out = self.root / "new-output"
        self.job = {"book": "fixture", "status": "completed", "acceptance_contract_version": 2,
                    "execution_mode": "structured_source", "generator_profile": "structured_source",
                    "verifier_profile": "unstructured_analysis", "model": "gen", "verifier_model": "ver",
                    "total_calls": 2, "retried_calls": 0}
        self.validation = {"status": "completed", "ok": True, "acceptance_contract_version": 2,
                           "generator_attempts": 1, "verifier_attempts": 1, "total_calls": 2,
                           "proposer_cards": 1, "cards_considered": 1, "cards_verified": 1,
                           "cards_valid": 1, "cards_unusable": 0, "cards_schema_or_span_rejected": 0}
        self.meta = {"model": "gen", "finish_reason": "stop", "http_status": 200, "error": None, "attempts": 1,
                     "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}
        self.card = {"work_id": "fixture", "window_id": "W1", "card_id": "W1#0", "route": "bounded_event",
                     "accepted_for_verification": True, "schema_errors": [], "generator_card": {"proposition_text": SECRET},
                     "rationale": SECRET}
        self.verifier = {**copy.deepcopy(self.card), "verifier": {
            "verdict": "entailed", "contract_overall": "entailed", "errors": [], "reason_codes": [],
            "checks": [{"field_path": "proposition_text", "verdict": "entailed", "reason": SECRET}],
            "raw_response": SECRET, "call_meta": {**copy.deepcopy(self.meta), "model": "ver", "capture_dir": "calls/000002_verifier"}}}
        self.generator = {"work_id": "fixture", "window_id": "W1", "proposed_count": 1,
                          "cards": [copy.deepcopy(self.card)], "call_meta": {**copy.deepcopy(self.meta), "capture_dir": "calls/000001_generator"}, "raw_response": SECRET}
        self.generator["cards"][0]["verifier"] = copy.deepcopy(self.verifier["verifier"])
        self.entries = [self.attempt("original", "original")]

    def attempt(self, name, kind, *, job=None, validation=None, generator=True, verifier=True):
        directory = self.root / name
        directory.mkdir()
        entry = {"work_id": "fixture", "attempt_id": name, "attempt_kind": kind}
        values = {"job": job if job is not None else self.job,
                  "validation": validation if validation is not None else self.validation}
        if generator:
            values["generator"] = [self.generator]
        if verifier:
            values["verifier"] = [self.verifier]
        for key, value in values.items():
            path = directory / (key + (".jsonl" if key in ("generator", "verifier") else ".json"))
            (write_rows if key in ("generator", "verifier") else write_json)(path, value)
            entry[key] = ref(path)
        return entry

    def replace(self, key, value, entry=None):
        entry = self.entries[0] if entry is None else entry
        path = Path(entry[key]["path"])
        (write_rows if key in ("generator", "verifier") else write_json)(path, value)
        entry[key] = ref(path)

    def seal(self):
        write_json(self.inventory, {"schema_version": 1, "attempts": self.entries})
        return ref(self.inventory)["sha256"]

    def run_report(self, materialize=False):
        return E.report_efficiency(self.inventory, self.seal(), self.out, materialize=materialize)

    def reject(self, code=None):
        with self.assertRaises((ValueError, OSError, TypeError)) as error:
            self.run_report(materialize=True)
        if code:
            self.assertIn(code, str(error.exception))
        self.assertFalse(self.out.exists())

    def test_outer_generator_and_external_verifier_count_once(self):
        result = self.run_report()
        self.assertEqual(result["counts"]["call_metadata_rows"], 2)
        self.assertEqual(result["attempt_row_totals"]["known_usage"],
                         {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30})
        a = result["attempts"][0]
        self.assertEqual(a["accepted_card_token_cost"]["tokens_per_recorded_entailed_card"]["total_tokens"], 30)
        self.assertEqual(a["cardinality"]["observed"]["emitted"], 1)
        self.assertEqual(len(result["first_pass_by_stage"]), 2)
        self.assertNotIn(SECRET, json.dumps(result))

    def test_embedded_verifier_only_is_unavailable(self):
        del self.entries[0]["verifier"]
        result = self.run_report()
        a = result["attempts"][0]
        self.assertEqual(result["counts"]["call_metadata_rows"], 1)
        self.assertEqual(a["stages"][1]["availability"], "not_explicitly_declared")
        self.assertIsNone(a["cardinality"]["observed"]["valid"])
        self.assertIsNone(a["accepted_card_token_cost"])
        self.assertIsNone(a["cardinality"]["per_route"][0]["valid"])

    def test_eligible_is_distinct_from_observed_submissions(self):
        self.generator["cards"].append({**copy.deepcopy(self.card), "card_id": "W1#1"})
        self.replace("generator", [self.generator])
        result = self.run_report()
        observed = result["attempts"][0]["cardinality"]["observed"]
        self.assertEqual((observed["emitted"], observed["eligible_for_verification"], observed["submitted_for_verification"]), (2, 2, 1))

    def test_duplicate_capture_ids_and_conflicting_file_roles_rejected(self):
        row = copy.deepcopy(self.generator)
        row["call_meta"]["capture_dir"] = "calls/000001_generator"
        second = {**copy.deepcopy(row), "window_id": "W2", "cards": []}
        self.replace("generator", [row, second])
        self.reject("duplicate_capture_id")
        self.replace("generator", [self.generator])
        self.entries[0]["verifier"] = self.entries[0]["generator"]
        self.reject("conflicting_artifact_roles")

    def test_reverify_reused_generator_ref_is_indexed_without_compute(self):
        self.entries.append(self.attempt("reverify", "reverify", generator=False,
                                         validation={**self.validation, "generator_attempts": 0, "total_calls": 1}))
        self.entries[1]["generator"] = copy.deepcopy(self.entries[0]["generator"])
        result = self.run_report()
        self.assertEqual(result["counts"]["call_metadata_rows"], 3)
        self.assertEqual(result["attempts"][1]["cardinality"]["observed"]["emitted"], 1)
        self.assertEqual(result["attempts"][1]["lineage"]["status"], "joined")
        self.assertEqual(result["attempts"][1]["stages"][0]["availability"], "reused_not_compute")

    def test_missing_call_metadata_is_separate_from_missing_usage(self):
        del self.verifier["verifier"]["call_meta"]
        self.replace("verifier", [self.verifier])
        a = self.run_report()["attempts"][0]
        self.assertEqual(a["stages"][1]["rows_without_call_meta"], 1)
        self.assertEqual(a["cardinality"]["observed"]["submitted_for_verification"], 0)
        self.assertEqual(a["cardinality"]["observed"]["verifier_result_rows"], 1)
        self.assertIsNone(a["accepted_card_token_cost"])

    def test_original_and_reverify_are_separate_no_precedence(self):
        self.entries.append(self.attempt("reverify", "reverify", job={**self.job, "execution_mode": "verifier_only_reverify_8001"},
                                         validation={**self.validation, "generator_attempts": 0, "total_calls": 1}, generator=False))
        negative = copy.deepcopy(self.verifier)
        negative["verifier"].update(verdict="insufficient", contract_overall="insufficient_evidence")
        self.replace("verifier", [negative], self.entries[1])
        result = self.run_report()
        self.assertEqual(result["counts"]["call_metadata_rows"], 3)
        self.assertEqual([a["cardinality"]["observed"]["recorded_entailed"] for a in result["attempts"]], [1, 0])
        self.assertEqual(result["attempts"][1]["stages"][0]["availability"], "reused_not_compute")
        self.assertEqual(len(result["first_pass_by_stage"]), 2)
        self.assertNotIn("effective", json.dumps(result))

    def test_legacy_metadata_remains_unvalidated_but_observable(self):
        self.replace("job", {"book": "fixture", "model": "gen", "verifier_model": "ver"})
        self.replace("validation", {"ok": True})
        result = self.run_report()
        self.assertEqual(result["attempts"][0]["state"], "legacy_unvalidated")
        self.assertFalse(result["quality_certified"])
        self.assertEqual(result["counts"]["call_metadata_rows"], 2)
        self.assertIsNone(result["attempts"][0]["accepted_card_token_cost"])

    def test_partial_missing_and_invalid_usage_never_become_zero(self):
        self.generator["call_meta"]["usage"] = {"prompt_tokens": 10, "completion_tokens": True, "total_tokens": -1}
        del self.verifier["verifier"]["call_meta"]["usage"]
        self.replace("generator", [self.generator])
        self.replace("verifier", [self.verifier])
        result = self.run_report()
        total = result["attempt_row_totals"]
        self.assertEqual(total["known_usage"], {"prompt_tokens": 10, "completion_tokens": None, "total_tokens": None})
        self.assertEqual((total["calls_missing_usage"], total["calls_partial_usage"]), (1, 1))
        self.assertEqual(total["missing_or_partial_usage_rate"], 1)
        self.assertIsNone(result["attempts"][0]["accepted_card_token_cost"])

    def test_zero_usage_is_known_but_float_and_string_are_not(self):
        total = E.summarize_calls([({"usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}}, None, None),
                                   ({"usage": {"prompt_tokens": 1.0, "completion_tokens": "5"}}, None, None)])
        self.assertEqual(total["known_usage"]["total_tokens"], 0)
        self.assertEqual(total["calls_complete_usage"], 1)
        self.assertEqual(total["calls_missing_usage"], 1)

    def test_inconsistent_total_is_flagged_and_ratio_withheld(self):
        self.generator["call_meta"]["usage"]["total_tokens"] = 100
        self.replace("generator", [self.generator])
        result = self.run_report()
        self.assertEqual(result["attempt_row_totals"]["token_accounting_flags"], {"prompt_plus_completion_ne_total": 1})
        self.assertEqual(result["attempt_row_totals"]["known_usage"]["total_tokens"], 115)
        self.assertIsNone(result["attempts"][0]["accepted_card_token_cost"])

    def test_reasoning_unknown_and_explicit_details_only(self):
        self.generator["call_meta"].update(reasoning_tokens=999, reasoning=SECRET)
        self.generator["call_meta"]["usage"]["reasoning_tokens"] = 999
        self.replace("generator", [self.generator])
        self.assertIsNone(self.run_report()["attempt_row_totals"]["explicit_reasoning_tokens"])
        self.generator["call_meta"]["usage"]["completion_tokens_details"] = {"reasoning_tokens": 4}
        self.replace("generator", [self.generator])
        total = self.run_report()["attempt_row_totals"]
        self.assertEqual(total["explicit_reasoning_tokens"], 4)
        self.assertEqual(total["known_usage"]["total_tokens"], 30)
        self.generator["call_meta"]["usage"]["completion_tokens_details"]["reasoning_tokens"] = 6
        self.replace("generator", [self.generator])
        self.assertEqual(self.run_report()["attempt_row_totals"]["token_accounting_flags"], {"reasoning_gt_completion": 1})

    def test_reported_retries_do_not_multiply_captured_usage(self):
        self.replace("validation", {**self.validation, "generator_attempts": 4, "total_calls": 5})
        result = self.run_report()
        stage = result["attempts"][0]["stages"][0]
        self.assertEqual((stage["reported_attempts"], stage["call_metadata_rows"], stage["reported_minus_call_rows"]), (4, 1, 3))
        self.assertEqual(result["attempt_row_totals"]["known_usage"]["total_tokens"], 30)
        self.assertIsNone(result["attempts"][0]["accepted_card_token_cost"])

    def test_errors_finishes_and_model_mismatch(self):
        self.verifier["verifier"]["call_meta"].update(model="other", finish_reason="length", error="http_error:" + SECRET, http_status=503)
        self.verifier["verifier"].update(errors=["contract_error:" + SECRET], contract_overall="insufficient_evidence")
        self.replace("verifier", [self.verifier])
        result = self.run_report()
        total = result["attempt_row_totals"]
        self.assertEqual(total["model_identity_mismatches"], 1)
        self.assertEqual(total["finish_counts"], {"length": 1, "stop": 1})
        self.assertEqual(total["error_calls"], 1)
        self.assertEqual(result["attempts"][0]["cardinality"]["observed"]["unusable"], 1)
        self.assertNotIn(SECRET, json.dumps(result))

    def test_insufficient_free_reason_is_never_semantically_classified(self):
        v = self.verifier["verifier"]
        v.update(verdict="insufficient", contract_overall="insufficient_evidence")
        v["checks"] = [{"field_path": "proposition_text", "verdict": "insufficient_evidence",
                        "reason": "missing context, truncation, wrong route " + SECRET}]
        self.replace("verifier", [self.verifier])
        diag = self.run_report()["attempts"][0]["verifier_diagnostics"]
        self.assertEqual(diag["insufficient_causes"], {"cause_unclassified_requires_review": 1})
        v["checks"][0]["reason_code"] = "not_established"
        self.replace("verifier", [self.verifier])
        diag = self.run_report()["attempts"][0]["verifier_diagnostics"]
        self.assertEqual(diag["insufficient_causes"], {"not_established": 1})
        self.assertEqual(diag["structured_reason_codes"], {"not_established": 1})

    def test_rejection_fields_and_routes_are_sanitized(self):
        rejected = {**self.card, "card_id": "W1#1", "route": SECRET, "accepted_for_verification": False,
                    "schema_errors": ["unknown_key:" + SECRET, SECRET]}
        self.generator["cards"].append(rejected)
        self.replace("generator", [self.generator])
        self.verifier["verifier"]["checks"].append({"field_path": SECRET, "verdict": "entailed", "reason": SECRET})
        self.replace("verifier", [self.verifier])
        result = self.run_report()
        a = result["attempts"][0]
        self.assertEqual(a["cardinality"]["observed_minus_reported"]["emitted"], 1)
        self.assertEqual(a["cardinality"]["rejected_reason_groups"], {"unknown_code": 1, "unknown_key": 1})
        self.assertIn("unknown", [r["route"] for r in a["cardinality"]["per_route"]])
        self.assertNotIn(SECRET, json.dumps(result))

    def test_pending_does_not_read_result_files_and_cannot_materialize(self):
        self.replace("job", {**self.job, "status": "running"})
        self.replace("validation", {**self.validation, "status": "running"})
        original = Path.read_bytes
        blocked = {Path(self.entries[0][s]["path"]) for s in ("generator", "verifier")}

        def guarded(path):
            self.assertNotIn(path, blocked)
            return original(path)

        with mock.patch.object(Path, "read_bytes", guarded):
            result = self.run_report()
            self.assertFalse(result["snapshot_accepted"])
            self.assertEqual(result["attempts"][0]["state"], "pending")
            self.reject("pending_snapshot_not_materializable")
        self.assertEqual(result["counts"]["call_metadata_rows"], 0)
        args = ["--inputs", str(self.inventory), "--inputs-sha256", self.seal(), "--out-dir", str(self.out)]
        with redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(E.main(args), 3)
        self.assertFalse(json.loads(stdout.getvalue())["snapshot_accepted"])

    def test_contradictory_status_blocks_before_results(self):
        for changes in ({"status": "running"}, {"status": "failed"}, {"ok": False}):
            self.replace("job", {**self.job, **changes})
            self.reject("contradictory")

    def test_v2_versions_and_status_presence_are_strict(self):
        for changes in ({"acceptance_contract_version": True}, {"acceptance_contract_version": 2.0}, {"status": None}):
            self.replace("job", {**self.job, **changes})
            self.reject()

    def test_duplicate_attempt_row_card_ids_and_bad_ids(self):
        self.entries *= 2
        self.reject("duplicate_attempt_id")
        self.entries = self.entries[:1]
        self.replace("generator", [self.generator, self.generator])
        self.reject("duplicate_row_id")
        self.generator["cards"].append(copy.deepcopy(self.generator["cards"][0]))
        self.replace("generator", [self.generator])
        self.reject("duplicate_card_id")
        self.generator["cards"] = self.generator["cards"][:1]
        self.replace("generator", [self.generator])
        self.replace("verifier", [self.verifier, self.verifier])
        self.reject("duplicate_row_id")
        self.replace("verifier", [self.verifier])
        for bad in (None, True, "", " ", "bad\nid", "../escape", "bad|id", "has space"):
            self.entries[0]["attempt_id"] = bad
            self.reject("invalid_id")

    def test_wrong_work_or_window_bindings_rejected(self):
        for obj, key, value in ((self.generator, "work_id", "another"), (self.card, "window_id", "W2")):
            row = copy.deepcopy(self.generator)
            if obj is self.generator:
                row[key] = value
            else:
                row["cards"][0][key] = value
            self.replace("generator", [row])
            self.reject()

    def test_duplicate_keys_nan_overflow_and_deep_json_fail(self):
        target = Path(self.entries[0]["generator"]["path"])
        for data in (b'{"window_id":"W1","window_id":"W1"}\n', b'{"x":NaN}', b'{"x":Infinity}',
                     b'{"x":1e999}', b'{"x":' + b'[' * 10000 + b'0' + b']' * 10000 + b'}', b'\xff'):
            target.write_bytes(data)
            self.entries[0]["generator"] = ref(target)
            self.reject()

    def test_literal_unicode_separators_are_not_jsonl_record_boundaries(self):
        self.generator["raw_response"] = "secret\u2028source\u2029text\u0085tail"
        self.replace("generator", [self.generator])
        result = self.run_report()
        self.assertEqual(result["attempts"][0]["stages"][0]["observed_rows"], 1)
        self.assertNotIn("source", json.dumps(result["attempt_row_totals"]))

    def test_paths_hash_pins_and_links_fail_closed(self):
        original = copy.deepcopy(self.entries[0]["generator"])
        for path in ("relative", str(self.root / ".." / "escape"), str(self.root / "bad:stream"),
                     str(self.root / "nul.json"), "\\\\?\\C:\\device", "\\\\host\\share\\file", str(self.root / "bad. ")):
            self.entries[0]["generator"] = {**original, "path": path}
            self.reject()
        self.entries[0]["generator"] = {**original, "sha256": "A" * 64}
        self.reject("bad_reference")
        self.entries[0]["generator"] = {**original, "sha256": "0" * 64}
        self.reject("input_hash_mismatch")
        self.entries[0]["generator"] = original
        ancestor = Path(original["path"]).parent
        lstat = Path.lstat

        def reparse(path):
            info = lstat(path)
            return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400) if path == ancestor else info

        with mock.patch.object(Path, "lstat", reparse):
            self.reject("unsafe_path_link")

    def test_conflicting_and_repeated_result_pins_rejected(self):
        self.entries[0]["verifier"] = {**self.entries[0]["generator"], "sha256": "0" * 64}
        self.reject("conflicting_pins")
        self.entries[0]["verifier"] = ref(self.root / "original/verifier.jsonl")
        second = copy.deepcopy(self.entries[0])
        second["attempt_id"] = "second"
        self.entries.append(second)
        self.reject("duplicate_result_reference")

    def test_only_explicit_pins_are_opened_no_metadata_path_following(self):
        self.job["output_file_hashes"] = {"../forbidden": "a" * 64}
        self.job["source_generator_jsonl"] = str(self.root / "never-open")
        self.generator["call_meta"]["capture_dir"] = str(self.root / "never-open")
        self.replace("job", self.job)
        self.replace("generator", [self.generator])
        allowed = {self.inventory} | {Path(self.entries[0][k]["path"]) for k in ("job", "validation", "generator", "verifier")}
        original = Path.read_bytes

        def guarded(path):
            self.assertIn(path, allowed)
            return original(path)

        with mock.patch.object(Path, "read_bytes", guarded):
            self.run_report()

    def test_final_rehash_rejects_all_input_mutations_before_output(self):
        original = E.Inputs.recheck
        for target in [self.inventory] + [Path(self.entries[0][k]["path"]) for k in ("job", "validation", "generator", "verifier")]:
            with self.subTest(target=target.name):
                before = target.read_bytes() if target.exists() else None

                def mutate(store):
                    target.write_bytes(target.read_bytes() + b" ")
                    return original(store)

                with mock.patch.object(E.Inputs, "recheck", mutate):
                    self.reject("input_changed")
                if before is not None:
                    target.write_bytes(before)

    def test_cli_dry_run_materialize_new_only_and_safe_failure(self):
        args = ["--inputs", str(self.inventory), "--inputs-sha256", self.seal(), "--out-dir", str(self.out)]
        before = {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        with redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(E.main(args), 0)
        self.assertTrue(json.loads(stdout.getvalue())["dry_run"])
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()})
        self.assertFalse(self.out.exists())
        with redirect_stdout(io.StringIO()):
            self.assertEqual(E.main(args + ["--materialize"]), 0)
        payload = (self.out / "inference_efficiency.json").read_bytes()
        self.assertFalse(json.loads(payload)["dry_run"])
        self.assertNotIn(SECRET, payload.decode())
        for suffix in ([], ["--materialize"]):
            with redirect_stdout(io.StringIO()) as stdout, redirect_stderr(io.StringIO()) as stderr:
                self.assertEqual(E.main(args + suffix), 2)
            self.assertEqual(stdout.getvalue(), "")
            self.assertEqual(stderr.getvalue(), "FAIL: snapshot_rejected\n")
        self.assertEqual(payload, (self.out / "inference_efficiency.json").read_bytes())

    def test_inventory_closed_schema_and_external_hash(self):
        pin = self.seal()
        with self.assertRaises(ValueError):
            E.report_efficiency(self.inventory, "0" * 64, self.out)
        for value in ({"schema_version": True, "attempts": self.entries},
                      {"schema_version": 1, "attempts": []},
                      {"schema_version": 1, "attempts": self.entries, "extra": True}):
            write_json(self.inventory, value)
            with self.assertRaises(ValueError):
                E.report_efficiency(self.inventory, ref(self.inventory)["sha256"], self.out)
        self.assertNotEqual(pin, "0" * 64)
        self.entries[0]["extra"] = True
        self.reject("bad_attempt_schema")

    def test_output_parent_must_exist_and_output_must_be_absolute(self):
        for out in ("relative", self.root / "missing-parent/output"):
            self.out = out
            with self.assertRaises(ValueError):
                self.run_report(materialize=True)
        self.assertFalse((self.root / "missing-parent").exists())

    def add_reverify_with_lineage(self):
        entry = self.attempt("reverify", "reverify", generator=False,
                             job={**self.job, "total_calls": 1, "execution_mode": "verifier_only_reverify_8001"},
                             validation={**self.validation, "generator_attempts": 0, "total_calls": 1})
        entry["generator"] = copy.deepcopy(self.entries[0]["generator"])
        self.entries.append(entry)
        return entry

    def test_cross_attempt_absolute_capture_copy_flags_both_costs(self):
        other = self.add_reverify_with_lineage()
        origin = self.root / "original/calls/000002_verifier"
        self.verifier["verifier"]["call_meta"]["capture_dir"] = str(origin)
        self.replace("verifier", [self.verifier])
        self.replace("verifier", [self.verifier], other)
        result = self.run_report()
        self.assertFalse(result["unique_provider_compute_known"])
        self.assertEqual(result["counts"]["call_metadata_rows"], 3)
        self.assertEqual(result["attempt_row_totals"]["rows_with_suspected_duplicate_origin"], 2)
        self.assertEqual(result["attempt_row_totals"]["known_usage"]["total_tokens"], 45)
        self.assertEqual(len(result["suspected_duplicate_capture_origins"]), 1)
        self.assertEqual([a["rows_with_suspected_duplicate_origin"] for a in result["attempts"]], [1, 1])
        self.assertTrue(all(a["accepted_card_token_cost"] is None for a in result["attempts"]))

    def test_absolute_origin_matches_job_anchored_relative_origin(self):
        other = self.add_reverify_with_lineage()
        row = copy.deepcopy(self.verifier)
        row["verifier"]["call_meta"]["capture_dir"] = (self.root / "original/calls/000002_verifier").as_posix()
        self.replace("verifier", [row], other)
        result = self.run_report()
        self.assertEqual(result["attempt_row_totals"]["rows_with_suspected_duplicate_origin"], 2)
        self.assertIsNone(result["attempts"][0]["accepted_card_token_cost"])

    def test_windows_capture_origins_normalize_case_and_separators_without_reads(self):
        refs = {"path": str(self.root / "job.json")}
        with mock.patch.object(Path, "stat", side_effect=AssertionError("capture lookup forbidden")):
            first = E.capture_origin({"capture_dir": "D:/Fixture/Original/CALLS/000002_VERIFIER"}, refs, "verifier")
            second = E.capture_origin({"capture_dir": "d:\\fixture\\original\\calls\\000002_verifier"}, refs, "verifier")
        self.assertTrue(first)
        self.assertEqual(first, second)

    def test_repeated_relative_capture_names_in_actual_attempts_stay_separate(self):
        self.add_reverify_with_lineage()
        result = self.run_report()
        self.assertEqual(result["attempt_row_totals"]["calls_with_capture_identity"], 3)
        self.assertEqual(result["attempt_row_totals"]["distinct_claimed_capture_origins"], 3)
        self.assertEqual(result["suspected_duplicate_capture_origins"], [])
        self.assertFalse(result["unique_provider_compute_known"])
        self.assertEqual(result["attempts"][1]["accepted_card_token_cost"]["tokens_per_recorded_entailed_card"]["total_tokens"], 15)

    def test_same_verifier_reference_alias_cannot_count_twice(self):
        other = self.add_reverify_with_lineage()
        other["verifier"] = copy.deepcopy(self.entries[0]["verifier"])
        self.reject("duplicate_result_reference")

    def test_hardlinked_verifier_alias_cannot_count_twice(self):
        other = self.add_reverify_with_lineage()
        path = Path(other["verifier"]["path"])
        path.unlink()
        path.hardlink_to(Path(self.entries[0]["verifier"]["path"]))
        other["verifier"] = ref(path)
        self.reject("duplicate_physical_result_reference")

    def test_capture_identity_missing_or_invalid_prevents_ratio(self):
        for value in (None, "../calls/000002_verifier", "calls/000002_generator", "arbitrary/" + SECRET):
            row = copy.deepcopy(self.verifier)
            row["verifier"]["call_meta"]["capture_dir"] = value
            self.replace("verifier", [row])
            result = self.run_report()
            self.assertEqual(result["attempt_row_totals"]["calls_with_capture_identity"], 1)
            self.assertIsNone(result["attempts"][0]["accepted_card_token_cost"])
            self.assertNotIn(SECRET, json.dumps(result))

    def test_equal_counts_do_not_hide_verifier_identity_window_or_route_mismatch(self):
        for change in ({"card_id": "unrelated-card"}, {"window_id": "W2"}, {"route": "mechanism"}, {"work_id": "other"}):
            self.replace("verifier", [{**copy.deepcopy(self.verifier), **change}])
            self.reject()
        self.generator["cards"][0]["accepted_for_verification"] = False
        self.replace("generator", [self.generator])
        self.replace("verifier", [self.verifier])
        self.reject("verifier_card_not_generator_eligible")

    def test_reverify_reused_generator_is_required_to_match_lineage(self):
        other = self.add_reverify_with_lineage()
        self.replace("verifier", [{**copy.deepcopy(self.verifier), "route": "mechanism"}], other)
        self.reject("verifier_lineage_mismatch")

    def test_absent_generator_or_missing_work_identity_means_unknown_join(self):
        gen_ref = self.entries[0].pop("generator")
        result = self.run_report()
        self.assertEqual(result["attempts"][0]["lineage"]["status"], "unknown")
        self.assertIsNone(result["attempts"][0]["accepted_card_token_cost"])
        self.entries[0]["generator"] = gen_ref
        row = copy.deepcopy(self.verifier)
        del row["work_id"]
        self.replace("verifier", [row])
        a = self.run_report()["attempts"][0]
        self.assertEqual(a["lineage"]["unknown_verifier_rows"], 1)
        self.assertIsNone(a["accepted_card_token_cost"])

    def test_call_attempts_and_job_retry_count_conflict_with_validation(self):
        self.generator["call_meta"]["attempts"] = 4
        self.replace("generator", [self.generator])
        self.replace("job", {**self.job, "retried_calls": 3})
        a = self.run_report()["attempts"][0]
        retry = a["retry_accounting"]
        self.assertEqual(retry["job_retried_calls"], 3)
        self.assertEqual(retry["observed"]["known_call_attempts_sum"], 5)
        self.assertEqual(retry["observed"]["known_prior_retry_attempts"], 3)
        self.assertEqual(retry["observed"]["calls_with_explicit_retries"], 1)
        self.assertEqual(retry["validation_minus_call_attempts"], -3)
        self.assertIn("validation_total_vs_call_attempts_mismatch", retry["conflicts"])
        self.assertIn("job_retried_calls_mismatch", retry["conflicts"])
        self.assertTrue(retry["observed"]["prior_retry_tokens_unknown"])
        self.assertIsNone(retry["observed"]["prior_retry_tokens"])
        self.assertEqual(retry["observed"]["known_usage"]["total_tokens"], 30)
        self.assertIsNone(a["accepted_card_token_cost"])

    def test_attempt_counts_are_strict_and_missing_knowledge_blocks_ratio(self):
        for value in (None, True, -1, "1", 1.0, 0):
            row = copy.deepcopy(self.generator)
            if value is None:
                del row["call_meta"]["attempts"]
            else:
                row["call_meta"]["attempts"] = value
            self.replace("generator", [row])
            a = self.run_report()["attempts"][0]
            self.assertFalse(a["retry_accounting"]["call_attempt_knowledge_complete"])
            self.assertTrue(a["retry_accounting"]["observed"]["prior_retry_tokens_unknown"])
            self.assertIsNone(a["accepted_card_token_cost"])

    def test_job_retry_missing_invalid_and_positive_values_block_ratio(self):
        for value in (None, True, -1, "0", 0.0, 1):
            job = copy.deepcopy(self.job)
            if value is None:
                del job["retried_calls"]
            else:
                job["retried_calls"] = value
            self.replace("job", job)
            a = self.run_report()["attempts"][0]
            self.assertIsNone(a["accepted_card_token_cost"])
            self.assertTrue(a["retry_accounting"]["prior_retry_tokens_unknown"])
            if value != 1:
                self.assertIn("retried_calls", a["retry_accounting"]["missing_or_invalid_job_counts"])

    def test_every_required_reported_counter_must_be_present_and_integer(self):
        for field in E.COUNTS:
            for value in (None, True, -1, "1"):
                report = copy.deepcopy(self.validation)
                if value is None:
                    del report[field]
                else:
                    report[field] = value
                self.replace("validation", report)
                a = self.run_report()["attempts"][0]
                self.assertIn(field, a["missing_or_invalid_reported_counts"])
                self.assertFalse(a["cardinality"]["reported_counts_complete"])
                self.assertIsNone(a["accepted_card_token_cost"])

    def test_encoded_reason_error_and_enum_prose_never_escapes(self):
        encoded_prose = "PRIVATE_SOURCE_REASONING_RATIONALE_DO_NOT_EMIT"
        v = copy.deepcopy(self.verifier)
        v["verifier"].update(verdict="insufficient", contract_overall="insufficient_evidence",
                             reason_codes=[encoded_prose, "not_established:" + encoded_prose, "source_supported/" + encoded_prose])
        v["verifier"]["checks"] = [{"field_path": encoded_prose, "verdict": "insufficient_evidence",
                                     "reason_code": encoded_prose, "reason": SECRET}]
        v["verifier"]["call_meta"].update(finish_reason=encoded_prose, error=encoded_prose)
        self.replace("verifier", [v])
        self.replace("job", {**self.job, "execution_mode": encoded_prose, "generator_profile": encoded_prose})
        result = self.run_report()
        text = json.dumps(result)
        self.assertNotIn(encoded_prose, text)
        self.assertNotIn(SECRET, text)
        diag = result["attempts"][0]["verifier_diagnostics"]
        self.assertEqual(diag["structured_reason_codes"], {"unknown_code": 4})
        self.assertEqual(diag["insufficient_causes"], {"cause_unclassified_requires_review": 1})
        self.assertEqual(result["attempts"][0]["execution_mode"], "unknown")
        self.assertEqual(result["attempt_row_totals"]["finish_counts"], {"stop": 1, "unknown": 1})

    def test_only_contract_reason_vocabulary_is_exposed(self):
        v = copy.deepcopy(self.verifier)
        v["verifier"].update(verdict="insufficient", contract_overall="insufficient_evidence",
                             reason_codes=sorted(E.REASONS))
        self.replace("verifier", [v])
        diag = self.run_report()["attempts"][0]["verifier_diagnostics"]
        self.assertEqual(set(diag["structured_reason_codes"]), E.REASONS)
        self.assertEqual(set(diag["insufficient_causes"]), E.REASONS)

    def test_model_identity_mismatch_or_missing_blocks_token_ratio(self):
        for value in (None, "other", ""):
            row = copy.deepcopy(self.verifier)
            row["verifier"]["call_meta"]["model"] = value
            self.replace("verifier", [row])
            self.assertIsNone(self.run_report()["attempts"][0]["accepted_card_token_cost"])


if __name__ == "__main__":
    unittest.main()
