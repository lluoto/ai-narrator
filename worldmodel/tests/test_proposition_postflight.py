"""Offline postflight tests using temporary metadata, never model/runtime calls."""

import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tools import inspect_proposition_attempt as postflight
from tools import proposition_attempts as evidence


class PostflightTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.attempt = self.root / "output"

    def write(self, name, value):
        self.attempt.mkdir(exist_ok=True)
        (self.attempt / name).write_text(json.dumps(value), encoding="utf-8")

    def terminal(self, status="completed"):
        self.write("job_record.json", {
            "status": status, "acceptance_contract_version": 2,
            "job_id": "fixture", "book": "fixture_book", "roles": ["rule_atom_read"],
            "execution_mode": "structured_source", "generator_profile": "structured_source",
            "input_artifact_hashes": {"sentences.jsonl": "a" * 64}, "output_file_hashes": {},
            "endpoint": "SECRET", "source_text": "SECRET", "total_calls": 999,
        })
        report = {
            "acceptance_contract_version": 2, "status": status, "ok": status != "failed",
            "generation_complete": True, "verification_complete": True, "execution_complete": True,
            "candidate_output_written": False, "terminal_failure": None,
            "unattempted_window_ids": [], "unattempted_card_ids": [],
            "verdicts": {}, "verifier_error_counts": {}, "raw_response": "SECRET",
            "source_text": "SECRET", "checks": {"prose": "SECRET"}, "quality_certified": True,
            **dict.fromkeys(postflight.COUNT_FIELDS, 0),
        }
        self.write("validation_report.json", report)
        return report

    def cli(self, path):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            rc = postflight.main(["--attempt", str(path)])
        output = stdout.getvalue()
        result = json.loads(output)
        self.assertEqual(len(output.splitlines()), 1)
        self.assertIs(result["quality_certified"], False)
        self.assertIs(result["no_runtime_effect"], True)
        self.assertIs(result["read_only"], True)
        self.assertNotIn("SECRET", output)
        return rc, result

    def test_not_started_does_not_create_output_or_validate(self):
        with mock.patch.object(postflight, "validated_report_status") as checker:
            rc, result = self.cli(self.attempt)
        self.assertEqual(rc, 3)
        self.assertEqual(result["observed_state"], "not_started")
        self.assertIsNone(result["validation_report_sha256"])
        self.assertFalse(self.attempt.exists())
        checker.assert_not_called()

    def test_running_and_incomplete_jobs_without_report_are_pending(self):
        for status in ("running", "incomplete", "completed", "failed"):
            with self.subTest(status=status):
                self.write("job_record.json", {"status": status, "acceptance_contract_version": 2})
                with mock.patch.object(postflight, "validated_report_status") as checker:
                    rc, result = self.cli(self.attempt)
                self.assertEqual((rc, result["observed_state"]), (3, "pending"))
                self.assertEqual(result["strict_validator_status"], "not_run")
                self.assertEqual(result["job_record_sha256"], evidence.file_sha256(self.attempt / "job_record.json"))
                checker.assert_not_called()

    def test_empty_directory_and_nonterminal_reports_do_not_validate_or_scan(self):
        self.attempt.mkdir()
        for report in (None, {}, {"acceptance_contract_version": 2},
                       {"status": "running", "ok": True}, {"status": "incomplete"}):
            with self.subTest(report=report):
                if report is not None:
                    self.write("validation_report.json", report)
                with mock.patch.object(postflight, "validated_report_status") as checker, \
                     mock.patch.object(Path, "iterdir", side_effect=AssertionError("scan forbidden")), \
                     mock.patch.object(Path, "rglob", side_effect=AssertionError("scan forbidden")):
                    rc, result = self.cli(self.attempt)
                self.assertEqual((rc, result["observed_state"]), (3, "pending"))
                checker.assert_not_called()

    def test_legacy_ok_is_not_accepted(self):
        self.write("job_record.json", {"acceptance_contract_version": 2})
        self.write("validation_report.json", {"ok": True})
        with mock.patch.object(postflight, "validated_report_status", wraps=evidence.validated_report_status) as checker:
            rc, result = self.cli(self.attempt)
        self.assertEqual((rc, result["observed_state"]), (1, "legacy_unvalidated"))
        self.assertEqual(result["strict_validator_status"], "legacy_unvalidated")
        self.assertIsNone(result["acceptance_version"])
        checker.assert_called_once_with(self.attempt,
                                        expected_job_hash=evidence.file_sha256(self.attempt / "job_record.json"),
                                        expected_report_hash=evidence.file_sha256(self.attempt / "validation_report.json"))

    def test_strict_failed_report_remains_failed(self):
        self.terminal("failed")
        with mock.patch.object(postflight, "validated_report_status", wraps=evidence.validated_report_status) as checker:
            rc, result = self.cli(self.attempt)
        self.assertEqual((rc, result["observed_state"]), (1, "failed"))
        self.assertEqual(result["strict_validator_status"], "invalid")
        checker.assert_called_once()

    def test_completion_requires_shared_strict_validator_and_binds_job_hash(self):
        for status in ("completed", "no_eligible_windows"):
            with self.subTest(status=status):
                self.terminal(status)
                with mock.patch.object(postflight, "validated_report_status", return_value=status) as checker:
                    rc, result = self.cli(self.attempt)
                digest = evidence.file_sha256(self.attempt / "job_record.json")
                checker.assert_called_once_with(
                    self.attempt, expected_job_hash=digest,
                    expected_report_hash=evidence.file_sha256(self.attempt / "validation_report.json"))
                self.assertEqual((rc, result["observed_state"]), (0, status))
                self.assertEqual(result["strict_validator_status"], status)
                self.assertEqual(result["acceptance_version"], 2)
                self.assertEqual(result["scope"]["book"], "fixture_book")
                self.assertEqual(result["work"]["execution_mode"], "structured_source")
                self.assertTrue(result["completion_flags"]["execution_complete"])
                self.assertTrue(result["metadata_stable"])
                self.assertEqual(result["counts"]["total_calls"], 0)
                self.assertEqual(result["job_record_sha256"], digest)
                self.assertEqual(result["validation_report_sha256"],
                                 evidence.file_sha256(self.attempt / "validation_report.json"))

    def test_real_shared_no_work_and_output_tamper_validation(self):
        self.terminal("no_eligible_windows")
        rc, result = self.cli(self.attempt)
        self.assertEqual((rc, result["observed_state"]), (0, "no_eligible_windows"))
        artifact = self.attempt / "artifact.jsonl"
        artifact.write_bytes(b"fixture\n")
        job_path = self.attempt / "job_record.json"
        job = json.loads(job_path.read_text(encoding="utf-8"))
        job["output_file_hashes"] = {artifact.name: evidence.file_sha256(artifact)}
        self.write(job_path.name, job)
        self.assertEqual(self.cli(self.attempt)[0], 0)
        artifact.write_bytes(b"tampered\n")
        rc, result = self.cli(self.attempt)
        self.assertEqual((rc, result["observed_state"]), (1, "invalid"))

    def test_terminal_invalid_cannot_complete(self):
        self.terminal()
        for strict in ("invalid", "legacy_unvalidated", "missing"):
            with self.subTest(strict=strict), \
                 mock.patch.object(postflight, "validated_report_status", return_value=strict):
                rc, result = self.cli(self.attempt)
            self.assertEqual(rc, 1)
            self.assertNotIn(result["observed_state"], postflight.SUCCESS_STATES)
        # A success-looking report is insufficient without the required artifact manifest.
        rc, result = self.cli(self.attempt)
        self.assertEqual((rc, result["observed_state"]), (1, "invalid"))

    def test_running_job_with_terminal_report_is_pending_without_output_scan(self):
        for status in postflight.IN_PROGRESS:
            with self.subTest(status=status):
                self.terminal()
                job_path = self.attempt / "job_record.json"
                job = json.loads(job_path.read_text(encoding="utf-8"))
                self.write(job_path.name, dict(job, status=status))
                with mock.patch.object(postflight, "validated_report_status") as checker, \
                     mock.patch.object(evidence.os, "walk", side_effect=AssertionError("scan forbidden")), \
                     mock.patch.object(Path, "iterdir", side_effect=AssertionError("scan forbidden")), \
                     mock.patch.object(Path, "rglob", side_effect=AssertionError("scan forbidden")):
                    rc, result = self.cli(self.attempt)
                self.assertEqual((rc, result["observed_state"]), (3, "pending"))
                self.assertEqual(result["strict_validator_status"], "not_run")
                self.assertEqual(result["counts"], {})
                self.assertTrue(all(value is None for value in result["completion_flags"].values()))
                checker.assert_not_called()

    def test_contradictory_terminal_job_report_statuses_are_invalid(self):
        for report_status, job_status in (("completed", "failed"), ("failed", "completed"),
                                          ("no_eligible_windows", "completed"),
                                          ("completed", "no_eligible_windows")):
            with self.subTest(report=report_status, job=job_status):
                self.terminal(report_status)
                job_path = self.attempt / "job_record.json"
                self.write(job_path.name, dict(json.loads(job_path.read_bytes()), status=job_status))
                rc, result = self.cli(self.attempt)
                self.assertEqual((rc, result["observed_state"]), (1, "invalid"))

    def test_helper_unstable_clears_completion_claims_even_when_metadata_is_stable(self):
        self.terminal("no_eligible_windows")
        with mock.patch.object(postflight, "validated_report_status", return_value="unstable"):
            rc, result = self.cli(self.attempt)
        self.assertEqual((rc, result["observed_state"]), (3, "pending"))
        self.assertEqual(result["strict_validator_status"], "unstable")
        self.assertEqual(result["counts"], {})
        self.assertTrue(all(value is None for value in result["completion_flags"].values()))

    def test_artifact_changed_after_hash_is_pending_with_real_validator(self):
        for change in ("tamper", "delete", "add"):
            with self.subTest(change=change):
                self.terminal("no_eligible_windows")
                artifact = self.attempt / "artifact.jsonl"
                artifact.write_bytes(b"fixture\n")
                job_path = self.attempt / "job_record.json"
                job = json.loads(job_path.read_bytes())
                job["output_file_hashes"] = {artifact.name: evidence.file_sha256(artifact)}
                self.write(job_path.name, job)
                original = evidence.file_sha256

                def hash_and_mutate(path):
                    digest = original(path)
                    if path == artifact:
                        if change == "delete":
                            artifact.unlink()
                        elif change == "add":
                            (self.attempt / "added.jsonl").write_bytes(b"new")
                        else:
                            artifact.write_bytes(b"changed\n")
                    return digest

                with mock.patch.object(evidence, "file_sha256", side_effect=hash_and_mutate):
                    rc, result = self.cli(self.attempt)
                self.assertEqual((rc, result["observed_state"]), (3, "pending"))
                self.assertEqual(result["strict_validator_status"], "unstable")
                self.assertEqual(result["counts"], {})
                self.assertTrue(all(value is None for value in result["completion_flags"].values()))

    def test_metadata_changed_during_initial_read_does_not_run_checker(self):
        self.terminal()
        job_path = self.attempt / "job_record.json"
        mutated = False
        def hash_and_change(path):
            nonlocal mutated
            digest = evidence.file_sha256(path)
            if path == job_path and not mutated:
                mutated = True
                path.write_bytes(path.read_bytes() + b" ")
            return digest
        with mock.patch.object(postflight, "file_sha256", side_effect=hash_and_change), \
             mock.patch.object(postflight, "validated_report_status") as checker:
            rc, result = self.cli(self.attempt)
        self.assertEqual((rc, result["observed_state"]), (3, "pending"))
        self.assertFalse(result["metadata_stable"])
        checker.assert_not_called()

    def test_job_or_report_changed_during_checker_cannot_complete(self):
        for name in postflight.METADATA_FILES:
            for change in ("append", "remove", "malformed"):
                with self.subTest(name=name, change=change):
                    self.terminal()
                    def mutate(*args, **kwargs):
                        path = self.attempt / name
                        if change == "remove":
                            path.unlink()
                        elif change == "malformed":
                            path.write_bytes(b"{")
                        else:
                            path.write_bytes(path.read_bytes() + b" ")
                        return "completed"
                    with mock.patch.object(postflight, "validated_report_status", side_effect=mutate):
                        rc, result = self.cli(self.attempt)
                    self.assertEqual((rc, result["observed_state"]), (3, "pending"))
                    self.assertEqual(result["strict_validator_status"], "unstable")
                    self.assertIs(result["metadata_stable"], False)
                    self.assertEqual(result["counts"], {})
                    self.assertTrue(all(value is None for value in result["completion_flags"].values()))

    def test_malformed_metadata_is_pending_without_checker(self):
        for name in postflight.METADATA_FILES:
            for content in (b"{", b"[]", b"null", b'{"status":"running","status":"completed"}', b"\xff",
                            b'{"nested":' + b"[" * 10000 + b"0" + b"]" * 10000 + b"}"):
                with self.subTest(name=name, content=content):
                    self.terminal()
                    (self.attempt / name).write_bytes(content)
                    with mock.patch.object(postflight, "validated_report_status") as checker:
                        rc, result = self.cli(self.attempt)
                    self.assertEqual((rc, result["observed_state"]), (3, "pending"))
                    self.assertFalse(result["metadata_stable"])
                    checker.assert_not_called()

    def test_counts_are_report_only_allowlisted_nonnegative_integers(self):
        report = self.terminal("failed")
        report.update(total_calls=True, failures=-1, windows_requested="SECRET", arbitrary_count=99)
        self.write("validation_report.json", report)
        _, result = self.cli(self.attempt)
        for key in ("total_calls", "failures", "windows_requested", "arbitrary_count", "verdicts"):
            self.assertNotIn(key, result["counts"])

    def test_read_only_inspection_preserves_metadata_and_artifacts(self):
        self.terminal("no_eligible_windows")
        before = {path.name: path.read_bytes() for path in self.attempt.iterdir()}
        self.cli(self.attempt)
        after = {path.name: path.read_bytes() for path in self.attempt.iterdir()}
        self.assertEqual(before, after)

    def test_cli_invalid_paths_do_not_validate(self):
        file_path = self.root / "not_a_directory"
        file_path.write_bytes(b"fixture")
        for path in ("relative/output", file_path, "\\\\server\\share\\output", "//server/share/output",
                     self.root / "bad\x00path"):
            with self.subTest(path=path), mock.patch.object(postflight, "validated_report_status") as checker:
                rc, result = self.cli(path)
            self.assertEqual((rc, result["observed_state"]), (1, "invalid"))
            checker.assert_not_called()

    def test_symlink_metadata_is_rejected_without_reading_target(self):
        self.terminal()
        original = Path.is_symlink
        target = self.attempt / "job_record.json"
        with mock.patch.object(Path, "is_symlink", lambda path: path == target or original(path)), \
             mock.patch.object(postflight, "validated_report_status") as checker:
            rc, result = self.cli(self.attempt)
        self.assertEqual((rc, result["observed_state"]), (1, "invalid"))
        checker.assert_not_called()

    def test_cli_usage_and_help_document_exit_codes(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            postflight.main([])
        self.assertEqual(error.exception.code, 2)
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as help_exit:
            postflight.main(["--help"])
        self.assertEqual(help_exit.exception.code, 0)
        help_text = " ".join(output.getvalue().split())
        for fragment in ("0 =", "1 =", "2 =", "3 =", "strict", "Read-only"):
            self.assertIn(fragment, help_text)


if __name__ == "__main__":
    unittest.main()
