"""Synthetic scheduler evidence tests. Every subprocess and HTTP call is mocked."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tools import proposition_attempts as evidence


def load(name, filename):
    path = ROOT / "runs" / "_extraction_scheduler" / "20260924" / filename
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BATCH = load("scheduler_batch_safety_test", "run_wavea_canary_batch.py")
REVERIFY = load("scheduler_reverify_safety_test", "run_reverify_8001.py")
HASH = "a" * 64
CONTEXT = "b" * 64
INPUTS = {"coverage_partition.jsonl": HASH}


def write_json(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")


def refresh_manifest(directory):
    job_path = directory / "job_record.json"
    job = json.loads(job_path.read_text())
    job["output_file_hashes"] = {
        p.relative_to(directory).as_posix(): evidence.file_sha256(p)
        for p in directory.rglob("*") if p.is_file() and p.name not in {"job_record.json", "validation_report.json"}
    }
    write_json(job_path, job)


def write_report(directory, *, no_work=False, reverify_hash=None, **changes):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    report = {
        "acceptance_contract_version": 2, "ok": True,
        "status": "no_eligible_windows" if no_work else "completed",
        "generation_complete": True, "verification_complete": True,
        "execution_complete": True,
        "contract_errors": 0, "source_binding_errors": 0, "failures": 0, "window_errors": 0,
        "windows_requested": 0 if no_work else 2,
        "windows_processed": 0 if no_work else 2,
        "windows_completed": 0 if no_work else 2, "windows_unattempted": 0,
        "unattempted_window_ids": [], "unattempted_card_ids": [], "terminal_failure": None,
        "generation_errors": 0, "envelope_errors": 0, "verifier_contract_errors": 0,
        "proposer_cards": 0 if no_work else 2,
        "cards_schema_or_span_rejected": 0, "cards_unusable": 0, "cards_unattempted": 0,
        "cards_verified": 0 if no_work else 2,
        "cards_valid": 0 if no_work else 2, "cards_considered": 0 if no_work else 2,
        "generator_attempts": 0 if no_work else 2, "verifier_attempts": 0 if no_work else 2,
        "total_calls": 0 if no_work else 4,
        "verdicts": {} if no_work else {"entailed": 1, "insufficient": 1},
        "verifier_error_counts": {},
    }
    if no_work:
        report["candidate_output_written"] = False
    job = {"book": "book", "input_artifact_hashes": dict(INPUTS), "generator_profile": "structured_source",
           "acceptance_contract_version": 2, "status": report["status"]}
    if reverify_hash is not None:
        report.update(mode="verifier_only_reverify", generator_attempts=0,
                      total_calls=0 if no_work else 2,
                      source_generator_jsonl_sha256=reverify_hash)
        job["generator_jsonl_sha256"] = reverify_hash
    if not no_work:
        outputs = {"proposition_verifier.jsonl": b'{"mock":"verifier"}\n',
                   "stage_journal.jsonl": b'{"stage":"terminal"}\n',
                   "checkpoint.jsonl": b'{"status":"completed"}\n', "failures.jsonl": b""}
        outputs.update({"validated_route_queues/" + route + ".jsonl": b"" for route in evidence.ROUTE_NAMES})
        if reverify_hash is None:
            outputs.update({"proposition_generator.jsonl": b'{"fresh":"input"}\n',
                            "audit_sample_manifest.json": b'{}\n'})
        stages = ["generator"] * report["generator_attempts"] + ["verifier"] * report["verifier_attempts"]
        for index, stage in enumerate(stages, 1):
            for name in ("request_body.bin", "response_body.bin", "journal.jsonl"):
                outputs[f"calls/{index:06d}_{stage}/{name}"] = b'{"mock":"capture"}\n'
        for relative, data in outputs.items():
            path = directory / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    report.update(changes)
    write_json(directory / "validation_report.json", report)
    write_json(directory / "job_record.json", job)
    refresh_manifest(directory)
    return report


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def attempt(self, **kwargs):
        path = evidence.allocate_attempt(self.root / "book")
        write_report(path, **kwargs)
        return path

    def test_legacy_ok_never_becomes_strict_success(self):
        write_json(self.root / "validation_report.json", {"ok": True})
        self.assertEqual(evidence.validated_report_status(self.root), "legacy_unvalidated")
        self.assertIsNone(evidence.selected_attempt(self.root))

    def test_explicit_completion_and_accounting_are_required(self):
        cases = [
            {"ok": 1}, {"status": "unknown"}, {"generation_complete": False},
            {"verification_complete": 1}, {"contract_errors": 1}, {"contract_errors": False},
            {"windows_processed": 1}, {"window_errors": 1}, {"failures": 1},
            {"proposer_cards": 4}, {"cards_verified": True}, {"verdicts": {}},
            {"verdicts": {"unknown": 2}}, {"verifier_error_counts": {"bad_span": 1}},
            {"cards_schema_or_span_rejected": -1},
            {"execution_complete": False}, {"windows_completed": 1},
            {"windows_unattempted": 1}, {"unattempted_window_ids": ["W2"]},
            {"unattempted_card_ids": ["C2"]}, {"cards_valid": 1},
            {"cards_unusable": 1}, {"cards_unattempted": 1},
            {"generator_attempts": 1}, {"verifier_attempts": 1}, {"total_calls": 0},
            {"generation_errors": 1}, {"envelope_errors": 1}, {"verifier_contract_errors": 1},
            {"terminal_failure": {}}, {"acceptance_contract_version": 2.0},
            {"source_binding_errors": 1}, {"source_binding_errors": False},
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                path = self.attempt(**changes)
                self.assertEqual(evidence.validated_report_status(path), "invalid")
        for field in ("generation_complete", "verification_complete", "contract_errors", "verifier_error_counts",
                      "source_binding_errors"):
            path = self.attempt()
            report = json.loads((path / "validation_report.json").read_text())
            del report[field]
            write_json(path / "validation_report.json", report)
            self.assertEqual(evidence.validated_report_status(path), "invalid")

    def test_no_work_is_exact_zero_and_distinct_from_extraction(self):
        path = self.attempt(no_work=True)
        self.assertEqual(evidence.validated_report_status(path), "no_eligible_windows")
        for changes in ({"cards_verified": 1}, {"windows_requested": 1},
                        {"candidate_output_written": True}, {"generation_complete": False}):
            write_report(path, no_work=True, **changes)
            self.assertEqual(evidence.validated_report_status(path), "invalid")

    def test_missing_malformed_and_duplicate_key_reports_fail_closed(self):
        self.assertEqual(evidence.validated_report_status(self.root), "missing")
        for content in ("[1]", "{", '{"ok":true,"ok":true}', "null"):
            (self.root / "validation_report.json").write_text(content)
            self.assertEqual(evidence.validated_report_status(self.root), "invalid")

    def test_current_source_config_and_job_hash_must_match(self):
        path = self.attempt()
        good = {"expected_input_hashes": INPUTS, "expected_job_fields": {"book": "book"},
                "expected_job_hash": evidence.file_sha256(path / "job_record.json"),
                "expected_report_hash": evidence.file_sha256(path / "validation_report.json")}
        self.assertEqual(evidence.validated_report_status(path, **good), "completed")
        for bad in ({"expected_input_hashes": {"coverage_partition.jsonl": "c" * 64}},
                    {"expected_job_fields": {"book": "another"}}, {"expected_job_hash": HASH},
                    {"expected_report_hash": HASH}):
            self.assertEqual(evidence.validated_report_status(path, **bad), "invalid")

    def test_output_manifest_is_required_including_no_work(self):
        for no_work in (False, True):
            path = self.attempt(no_work=no_work)
            job_path = path / "job_record.json"
            job = json.loads(job_path.read_text())
            self.assertEqual(evidence.validated_report_status(path), "no_eligible_windows" if no_work else "completed")
            if no_work:
                self.assertEqual(job["output_file_hashes"], {})
            for manifest in (None, [], "", {} if not no_work else {"missing.jsonl": HASH}):
                write_json(job_path, dict(job, output_file_hashes=manifest))
                self.assertEqual(evidence.validated_report_status(path), "invalid")
            del job["output_file_hashes"]
            write_json(job_path, job)
            self.assertEqual(evidence.validated_report_status(path), "invalid")

    def test_job_version_and_terminal_status_must_exactly_match_report(self):
        for no_work in (False, True):
            path = self.attempt(no_work=no_work)
            job_path = path / "job_record.json"
            job = json.loads(job_path.read_bytes())
            for field, values in (("acceptance_contract_version", (None, True, 1, 2.0, 3)),
                                  ("status", (None, "running", "incomplete", "failed",
                                              "completed" if no_work else "no_eligible_windows"))):
                for value in values:
                    with self.subTest(no_work=no_work, field=field, value=value):
                        changed = dict(job)
                        if value is None:
                            changed.pop(field)
                        else:
                            changed[field] = value
                        write_json(job_path, changed)
                        self.assertEqual(evidence.validated_report_status(path), "invalid")

    def test_validator_parses_and_hashes_one_read_of_each_metadata_file(self):
        path = self.attempt()
        expected = {"expected_report_hash": evidence.file_sha256(path / "validation_report.json"),
                    "expected_job_hash": evidence.file_sha256(path / "job_record.json")}
        original = Path.read_bytes
        reads = []

        def read_once(target):
            reads.append(target)
            return original(target)

        with mock.patch.object(Path, "read_bytes", read_once):
            self.assertEqual(evidence.validated_report_status(path, **expected), "completed")
        self.assertCountEqual(reads, [path / "validation_report.json", path / "job_record.json"])

    def test_metadata_replaced_after_read_cannot_validate_new_bytes(self):
        for name in ("validation_report.json", "job_record.json"):
            with self.subTest(name=name):
                path = self.attempt()
                target = path / name
                old = target.read_bytes()
                expected = {"expected_report_hash" if name == "validation_report.json" else "expected_job_hash":
                            hashlib.sha256(old).hexdigest()}
                original = Path.read_bytes
                changed = False

                def read_and_replace(item):
                    nonlocal changed
                    data = original(item)
                    if item == target and not changed:
                        changed = True
                        write_json(item, dict(json.loads(data), status="failed"))
                    return data

                with mock.patch.object(Path, "read_bytes", read_and_replace):
                    self.assertEqual(evidence.validated_report_status(path, **expected), "unstable")

    def test_tree_changes_during_artifact_hashing_are_unstable_and_refuse_selection(self):
        mutations = ("overwrite_hashed", "delete_hashed", "add_file", "add_directory",
                     "replace_report", "replace_job", "replace_hashed_identity")
        original = evidence.file_sha256
        for operation in ("validate", "select", "selected"):
            for mutation in mutations:
                with self.subTest(operation=operation, mutation=mutation):
                    scope = self.root / (operation + "_" + mutation)
                    path = evidence.allocate_attempt(scope)
                    write_report(path)
                    if operation == "selected":
                        evidence.select_attempt(scope, path)
                    pointer = scope / "selected_attempt.json"
                    previous = pointer.read_bytes() if pointer.exists() else None
                    seen = []

                    def hash_and_mutate(target):
                        digest = original(target)
                        if target.parent == path and target.name in {"validation_report.json", "job_record.json"}:
                            return digest
                        seen.append(target)
                        if len(seen) == 2:
                            first = seen[0]
                            if mutation == "overwrite_hashed":
                                info = first.stat()
                                data = first.read_bytes()
                                first.write_bytes(bytes([data[0] ^ 1]) + data[1:] if data else b"x")
                                os.utime(first, ns=(info.st_atime_ns, info.st_mtime_ns))
                            elif mutation == "delete_hashed":
                                first.unlink()
                            elif mutation == "add_file":
                                (path / "new.jsonl").write_bytes(b"new")
                            elif mutation == "add_directory":
                                (path / "new_directory").mkdir()
                            else:
                                victim = (path / "validation_report.json" if mutation == "replace_report" else
                                          path / "job_record.json" if mutation == "replace_job" else first)
                                info = victim.stat()
                                replacement = self.root / "replacement"
                                data = victim.read_bytes()
                                if mutation != "replace_hashed_identity":
                                    data = evidence.json_bytes(dict(json.loads(data), status="failed"))
                                replacement.write_bytes(data)
                                os.utime(replacement, ns=(info.st_atime_ns, info.st_mtime_ns))
                                os.replace(replacement, victim)
                        return digest

                    with mock.patch.object(evidence, "file_sha256", side_effect=hash_and_mutate):
                        if operation == "validate":
                            self.assertEqual(evidence.validated_report_status(path), "unstable")
                        elif operation == "select":
                            with self.assertRaises(ValueError):
                                evidence.select_attempt(scope, path)
                        else:
                            self.assertIsNone(evidence.selected_attempt(scope))
                    self.assertGreaterEqual(len(seen), 2)
                    self.assertEqual(pointer.read_bytes() if pointer.exists() else None, previous)
                    self.assertFalse((scope / ".selection.lock").exists())

    def test_selection_rechecks_pins_and_tree_after_validator_before_return_or_publication(self):
        original = evidence.validated_report_status
        for operation in ("select", "selected"):
            for name in ("validation_report.json", "job_record.json", "proposition_verifier.jsonl"):
                for change in ("tamper", "delete"):
                    with self.subTest(operation=operation, name=name, change=change):
                        scope = self.root / (operation + name + change)
                        path = evidence.allocate_attempt(scope)
                        write_report(path)
                        if operation == "selected":
                            evidence.select_attempt(scope, path)

                        def validate_then_mutate(*args, **kwargs):
                            if operation == "select":
                                self.assertTrue((scope / ".selection.lock").exists())
                            status = original(*args, **kwargs)
                            self.assertEqual(status, "completed")
                            target = path / name
                            if change == "delete":
                                target.unlink()
                            else:
                                target.write_bytes(target.read_bytes() + b" ")
                            return status

                        with mock.patch.object(evidence, "validated_report_status", side_effect=validate_then_mutate):
                            if operation == "selected":
                                self.assertIsNone(evidence.selected_attempt(scope))
                            else:
                                with self.assertRaises((ValueError, OSError)):
                                    evidence.select_attempt(scope, path)
                                self.assertFalse((scope / "selected_attempt.json").exists())
                                # History can be orphaned; it is never published as the selected pointer.
                                self.assertEqual(len(list((scope / "selection_history").glob("*.json"))), 1)
                        self.assertFalse((scope / ".selection.lock").exists())
                        self.assertFalse(list(scope.glob(".selection-*.json")))

    def test_output_changes_in_second_hash_pass_are_unstable_and_never_published(self):
        original = evidence.file_sha256
        for operation in ("validate", "select"):
            for change in ("tamper", "delete"):
                with self.subTest(operation=operation, change=change):
                    scope = self.root / (operation + change)
                    path = evidence.allocate_attempt(scope)
                    write_report(path)
                    manifest = json.loads((path / "job_record.json").read_bytes())["output_file_hashes"]
                    seen = []

                    def hash_and_mutate(target):
                        digest = original(target)
                        seen.append(target)
                        if len(seen) == len(manifest) + 2:
                            # First output in pass two has already been hashed.
                            victim = seen[-2]
                            if change == "delete":
                                victim.unlink()
                            else:
                                victim.write_bytes(victim.read_bytes() + b"changed")
                        return digest

                    with mock.patch.object(evidence, "file_sha256", side_effect=hash_and_mutate):
                        if operation == "validate":
                            self.assertEqual(evidence.validated_report_status(path), "unstable")
                        else:
                            with self.assertRaises(ValueError):
                                evidence.select_attempt(scope, path)
                            self.assertFalse((scope / "selected_attempt.json").exists())
                    self.assertGreaterEqual(len(seen), len(manifest) + 2)

    def test_file_removed_during_initial_tree_observation_is_unstable(self):
        path = self.attempt()
        original = evidence.os.walk

        def walk_and_remove(*args, **kwargs):
            for root, directories, files in original(*args, **kwargs):
                if Path(root) == path:
                    (path / "proposition_generator.jsonl").unlink()
                yield root, directories, files

        with mock.patch.object(evidence.os, "walk", side_effect=walk_and_remove):
            self.assertEqual(evidence.validated_report_status(path), "unstable")

    def test_failed_superseding_selection_preserves_previous_pointer_and_history(self):
        scope = self.root / "book"
        first = self.attempt()
        evidence.select_attempt(scope, first)
        pointer = (scope / "selected_attempt.json").read_bytes()
        history = {p.name: p.read_bytes() for p in (scope / "selection_history").iterdir()}
        second = self.attempt()
        original = evidence.file_sha256

        def hash_and_delete(target):
            digest = original(target)
            if target == second / "job_record.json":
                (second / "proposition_verifier.jsonl").unlink()
            return digest

        with mock.patch.object(evidence, "file_sha256", side_effect=hash_and_delete):
            with self.assertRaises(ValueError):
                evidence.select_attempt(scope, second)
        self.assertEqual((scope / "selected_attempt.json").read_bytes(), pointer)
        for name, data in history.items():
            self.assertEqual((scope / "selection_history" / name).read_bytes(), data)
        self.assertEqual(evidence.selected_attempt(scope), first)

    def test_deep_or_nonfinite_json_is_invalid_at_all_metadata_boundaries(self):
        deep = b'{"nested":' + b"[" * 10000 + b"0" + b"]" * 10000 + b"}"
        for name in ("validation_report.json", "job_record.json"):
            for data in (deep, b'{"bad":NaN}', b'{"bad":Infinity}', b"\xff"):
                with self.subTest(name=name, prefix=data[:20]):
                    path = self.attempt()
                    (path / name).write_bytes(data)
                    self.assertEqual(evidence.validated_report_status(path), "invalid")
                    with self.assertRaises(ValueError):
                        evidence.select_attempt(self.root / "book", path)
        scope = self.root / "deep_selection"
        path = evidence.allocate_attempt(scope)
        write_report(path)
        evidence.select_attempt(scope, path)
        pointer = scope / "selected_attempt.json"
        old = pointer.read_bytes()
        for target in (pointer, scope / "selection_history" / (hashlib.sha256(old).hexdigest() + ".json")):
            target.write_bytes(deep)
            self.assertIsNone(evidence.selected_attempt(scope))
            self.assertEqual(evidence.selection_integrity_status(scope), "broken")
            with self.assertRaises(ValueError):
                evidence.select_attempt(scope, path)
            target.write_bytes(old)

    def test_every_result_and_capture_is_hash_checked_on_each_completion_check(self):
        scope = self.root / "book"
        path = self.attempt()
        evidence.select_attempt(scope, path)
        job = json.loads((path / "job_record.json").read_text())
        for relative in job["output_file_hashes"]:
            with self.subTest(relative=relative):
                artifact = path / relative
                old = artifact.read_bytes()
                artifact.write_bytes(old + b"tampered\n")
                self.assertEqual(evidence.validated_report_status(path), "invalid")
                self.assertIsNone(evidence.selected_attempt(scope))
                artifact.write_bytes(old)
                self.assertEqual(evidence.selected_attempt(scope), path)
                artifact.unlink()
                self.assertEqual(evidence.validated_report_status(path), "invalid")
                artifact.write_bytes(old)

    def test_required_normal_and_reverify_outputs_cannot_be_omitted_from_manifest(self):
        for reverify_hash in (None, HASH):
            path = self.attempt(reverify_hash=reverify_hash)
            job = json.loads((path / "job_record.json").read_text())
            for relative in job["output_file_hashes"]:
                if relative.startswith("calls/"):
                    continue
                with self.subTest(reverify=reverify_hash is not None, relative=relative):
                    artifact = path / relative
                    data = artifact.read_bytes()
                    artifact.unlink()
                    refresh_manifest(path)
                    self.assertEqual(evidence.validated_report_status(path), "invalid")
                    artifact.write_bytes(data)
                    refresh_manifest(path)
            self.assertEqual(evidence.validated_report_status(path), "completed")

    def test_manifest_covers_all_files_and_refuses_unsafe_paths_and_hashes(self):
        path = self.attempt()
        job_path = path / "job_record.json"
        job = json.loads(job_path.read_text())
        extra = path / "unmanifested.jsonl"
        extra.write_bytes(b"unlisted\n")
        self.assertEqual(evidence.validated_report_status(path), "invalid")
        extra.unlink()
        for relative in ("../escape.jsonl", "/absolute.jsonl", "C:/escape.jsonl", "calls\\escape.jsonl",
                         "./extra.jsonl", "a/../extra.jsonl", "a//extra.jsonl", "job_record.json", "validation_report.json"):
            with self.subTest(relative=relative):
                write_json(job_path, dict(job, output_file_hashes=dict(job["output_file_hashes"], **{relative: HASH})))
                self.assertEqual(evidence.validated_report_status(path), "invalid")
        for digest in (None, True, "", "not-a-hash", "A" * 64):
            manifest = dict(job["output_file_hashes"], **{"proposition_generator.jsonl": digest})
            write_json(job_path, dict(job, output_file_hashes=manifest))
            self.assertEqual(evidence.validated_report_status(path), "invalid")

    def test_call_captures_cannot_be_omitted_empty_or_miscounted_even_with_matching_hashes(self):
        for reverify_hash in (None, HASH):
            path = self.attempt(reverify_hash=reverify_hash)
            stage = "generator" if reverify_hash is None else "verifier"
            for filename in ("request_body.bin", "response_body.bin", "journal.jsonl"):
                artifact = path / "calls" / ("000001_" + stage) / filename
                old = artifact.read_bytes()
                for missing in (False, True):
                    with self.subTest(reverify=reverify_hash is not None, filename=filename, missing=missing):
                        if missing:
                            artifact.unlink()
                        else:
                            artifact.write_bytes(b"")
                        refresh_manifest(path)
                        self.assertEqual(evidence.validated_report_status(path), "invalid")
                        artifact.write_bytes(old)
                refresh_manifest(path)
            extra = path / "calls" / "000099_verifier" / "response_body.bin"
            extra.parent.mkdir()
            extra.write_bytes(b"extra capture")
            refresh_manifest(path)
            self.assertEqual(evidence.validated_report_status(path), "invalid")

    def test_symlink_result_paths_and_capture_directories_are_refused_without_host_privileges(self):
        path = self.attempt()
        original = Path.is_symlink
        for target in (path / "proposition_generator.jsonl", path / "validated_route_queues",
                       path / "calls" / "000001_generator", path / "job_record.json", path / "validation_report.json"):
            with self.subTest(target=target), mock.patch.object(Path, "is_symlink", lambda p: p == target or original(p)):
                self.assertEqual(evidence.validated_report_status(path), "invalid")

    def test_distinct_attempts_preserve_failed_and_historical_evidence(self):
        scope = self.root / "book"
        scope.mkdir()
        old = scope / "validation_report.json"
        old.write_bytes(b'{"ok":true}')
        first = self.attempt(ok=False)
        before = (first / "validation_report.json").read_bytes()
        second = self.attempt()
        self.assertNotEqual(first, second)
        self.assertEqual(old.read_bytes(), b'{"ok":true}')
        self.assertEqual((first / "validation_report.json").read_bytes(), before)
        self.assertIsNone(evidence.selected_attempt(scope))
        with self.assertRaises(ValueError):
            evidence.select_attempt(scope, first)

    def test_uuid_collision_cannot_reuse_existing_attempt(self):
        value = mock.Mock(hex="d" * 32)
        with mock.patch.object(evidence.uuid, "uuid4", return_value=value):
            path = evidence.allocate_attempt(self.root)
            path.parent.joinpath("evidence.txt").write_bytes(b"preserve")
            with self.assertRaises(FileExistsError):
                evidence.allocate_attempt(self.root)
        self.assertEqual(path.parent.joinpath("evidence.txt").read_bytes(), b"preserve")

    def test_explicit_second_selection_keeps_hash_chained_history(self):
        scope = self.root / "book"
        first = self.attempt()
        evidence.select_attempt(scope, first, context_sha256=CONTEXT)
        old_pointer = (scope / "selected_attempt.json").read_bytes()
        old_hash = hashlib.sha256(old_pointer).hexdigest()
        self.assertEqual(evidence.selected_attempt(scope, context_sha256=CONTEXT), first)
        self.assertIsNone(evidence.selected_attempt(scope, context_sha256=HASH))
        second = self.attempt()
        record = evidence.select_attempt(scope, second, context_sha256=CONTEXT)
        self.assertEqual(record["supersedes_sha256"], old_hash)
        self.assertEqual((scope / "selection_history" / (old_hash + ".json")).read_bytes(), old_pointer)
        self.assertEqual(evidence.selected_attempt(scope), second)
        self.assertEqual(len(list((scope / "selection_history").glob("*.json"))), 2)
        self.assertTrue(first.is_dir())

    def test_selection_integrity_separates_absent_broken_and_stale_context(self):
        scope = self.root / "book"
        self.assertEqual(evidence.selection_integrity_status(scope), "absent")
        path = self.attempt()
        evidence.select_attempt(scope, path, context_sha256=CONTEXT)
        self.assertEqual(evidence.selection_integrity_status(scope), "intact")
        self.assertIsNone(evidence.selected_attempt(scope, context_sha256=HASH))
        self.assertEqual(evidence.selection_integrity_status(scope), "intact")
        pointer = scope / "selected_attempt.json"
        old = pointer.read_bytes()
        pointer.write_bytes(b"{}")
        self.assertEqual(evidence.selection_integrity_status(scope), "broken")
        pointer.write_bytes(old)
        (scope / ".selection.lock").write_bytes(b"")
        self.assertEqual(evidence.selection_integrity_status(scope), "broken")

    def test_report_and_job_tamper_invalidate_selection(self):
        for filename in ("validation_report.json", "job_record.json"):
            with self.subTest(filename=filename):
                scope = self.root / filename
                path = evidence.allocate_attempt(scope)
                write_report(path)
                evidence.select_attempt(scope, path)
                with open(path / filename, "ab") as handle:
                    handle.write(b" ")
                self.assertIsNone(evidence.selected_attempt(scope))

    def test_pointer_tamper_traversal_missing_hash_and_history_refuse_fallback(self):
        scope = self.root / "book"
        path = self.attempt()
        evidence.select_attempt(scope, path)
        pointer = scope / "selected_attempt.json"
        original = pointer.read_bytes()
        original_record = json.loads(original)
        for changes in ({"selected_path": "../escape"}, {"selected_path": str(path)},
                        {"selected_path": "attempts/" + "f" * 32 + "/output"},
                        {"validation_report_sha256": HASH}, {"job_record_sha256": HASH},
                        {"job_record_sha256": None}, {"job_record_sha256": ""},
                        {"selection_version": True}):
            record = dict(original_record, **changes)
            # Even a self-consistently rewritten latest history cannot bypass validation.
            data = evidence.json_bytes(record)
            digest = hashlib.sha256(data).hexdigest()
            (scope / "selection_history" / (digest + ".json")).write_bytes(data)
            pointer.write_bytes(data)
            self.assertIsNone(evidence.selected_attempt(scope))
        pointer.write_bytes(original)
        history = scope / "selection_history" / (hashlib.sha256(original).hexdigest() + ".json")
        history.write_bytes(b"{}")
        self.assertIsNone(evidence.selected_attempt(scope))
        with self.assertRaises(ValueError):
            evidence.select_attempt(scope, self.attempt())

    def test_scope_and_attempt_symlinks_are_rejected(self):
        real = self.root / "real"
        real.mkdir()
        link = self.root / "link"
        try:
            link.symlink_to(real, target_is_directory=True)
        except OSError:
            self.skipTest("symlinks not permitted on this host")
        with self.assertRaises(ValueError):
            evidence.allocate_attempt(link)

    def test_reverify_cannot_be_selected_as_generator(self):
        path = self.attempt(reverify_hash=HASH)
        with self.assertRaises(ValueError):
            evidence.select_attempt(self.root / "book", path)
        evidence.select_attempt(self.root / "book", path, purpose="reverify",
                                expected_source_generator_hash=HASH)
        self.assertIsNone(evidence.selected_attempt(self.root / "book"))
        self.assertEqual(evidence.selected_attempt(self.root / "book", purpose="reverify",
                                                  expected_source_generator_hash=HASH), path)
        self.assertIsNone(evidence.selected_attempt(self.root / "book", purpose="reverify",
                                                    expected_source_generator_hash=CONTEXT))

    def test_new_core_v2_reports_align_without_network(self):
        from tools import proposition_canary_run as core
        for kind in ("no_work", "generation", "reverify"):
            with self.subTest(kind=kind):
                output = self.root / kind
                arguments = SimpleNamespace(
                    out_dir=str(output), job_id="test", gen_prompt=core.GEN_PROMPT,
                    ver_prompt=core.VER_PROMPT_CONTRACT, max_tokens=1500,
                    ver_max_tokens=16000, roles="rule_atom_read")
                profile = {"endpoint": "http://unused/v1/chat/completions", "model": "mock"}
                hashes = {core.GEN_PROMPT: HASH, core.VER_PROMPT_CONTRACT: HASH,
                          "coverage_partition.jsonl": HASH, "sentences.jsonl": HASH}
                window = {"window_id": "W1", "chapter_id": "C1", "role": "rule_atom_read",
                          "sentence_ids": ["S1"], "sentences_block": "mock sentence"}
                binding = None
                if kind == "reverify":
                    source = self.root / "source.jsonl"
                    source.write_bytes(b"")
                    binding = ([], [], {"source_generator_jsonl": str(source),
                                        "source_generator_jsonl_sha256": evidence.file_sha256(source)})
                meta = {"content": '{"propositions": []}', "http_status": 200,
                        "model": "mock", "finish_reason": "stop", "error": None}
                def capture(*args, capture_dir, **kwargs):
                    directory = Path(capture_dir)
                    directory.mkdir(parents=True)
                    for name in ("request_body.bin", "response_body.bin", "journal.jsonl"):
                        (directory / name).write_bytes(b'{"mock":"capture"}\n')
                    return dict(meta)
                with mock.patch.object(core, "call_model", side_effect=capture) as dispatch, \
                     mock.patch.object(core, "BASE", str(self.root)), \
                     mock.patch("urllib.request.urlopen", side_effect=AssertionError("HTTP forbidden")), \
                     contextlib.redirect_stdout(io.StringIO()):
                    rc = core.execute(arguments, "book", [] if kind == "no_work" else [window],
                                      profile, profile, ("system", "{sentences_block}"),
                                      ("system", "user"), hashes, "structured_source", binding)
                self.assertEqual(rc, 0)
                self.assertEqual(dispatch.call_count, int(kind == "generation"))
                job = json.loads((output / "job_record.json").read_text())
                self.assertIn("output_file_hashes", job)
                self.assertEqual(evidence.validated_report_status(output, expected_input_hashes=hashes),
                                 "no_eligible_windows" if kind == "no_work" else "completed")


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        temporary = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.root = Path(temporary)
        self.out = self.root / "out"
        self.cov = self.root / "coverage"
        self.cov.mkdir()
        self.output = io.StringIO()
        self.stack.enter_context(contextlib.redirect_stdout(self.output))
        for module in (BATCH, REVERIFY):
            self.stack.enter_context(mock.patch.object(module, "OUTROOT", str(self.out)))
            self.stack.enter_context(mock.patch.object(module, "LOG", str(self.out / (module.__name__ + ".jsonl"))))
            self.stack.enter_context(mock.patch.object(module, "job_expectations", side_effect=self.expectations))
            self.stack.enter_context(mock.patch.object(module, "health_preflight"))
        self.stack.enter_context(mock.patch.object(BATCH, "COV", str(self.cov)))
        self.stack.enter_context(mock.patch.dict(os.environ, {"DISABLE_LLM_THINKING": "1", "CANARY_GEN_PROFILE": "structured_source"}))
        self.http = self.stack.enter_context(mock.patch("urllib.request.urlopen", side_effect=AssertionError("HTTP forbidden")))
        self.child = self.stack.enter_context(mock.patch("subprocess.run", side_effect=self.child_success))
        self.stack.enter_context(mock.patch("shutil.rmtree", side_effect=AssertionError("deletion forbidden")))
        # Disable the deletion guard before TemporaryDirectory cleanup.
        # ExitStack unwinds patches before cleaning the temporary directory.

    def expectations(self, book, *, source_generator=None):
        expected = {"expected_input_hashes": INPUTS, "expected_job_fields": {"book": book}}
        context = CONTEXT
        if source_generator is not None:
            digest = evidence.file_sha256(source_generator)
            expected["expected_source_generator_hash"] = digest
            context = digest
        return expected, context

    def coverage(self, *books):
        for book in books:
            directory = self.cov / book
            directory.mkdir()
            (directory / "coverage_partition.jsonl").write_text("{}\n")

    def historical(self, book="book"):
        scope = self.out / book
        scope.mkdir(parents=True)
        (scope / "validation_report.json").write_bytes(b'{"ok":true}')
        (scope / "proposition_generator.jsonl").write_bytes(b'{"old":"input"}\n')
        return scope

    def child_success(self, args, **kwargs):
        self.assertNotIn("--overwrite", args)
        attempt = Path(args[args.index("--out-dir") + 1])
        self.assertFalse(attempt.exists(), "runner output must be absent")
        book = args[args.index("--book") + 1]
        options = {}
        if "--verifier-only" in args:
            source = Path(args[args.index("--gen-jsonl") + 1])
            options["reverify_hash"] = evidence.file_sha256(source)
        write_report(attempt, **options)
        job = json.loads((attempt / "job_record.json").read_text())
        job["book"] = book
        write_json(attempt / "job_record.json", job)
        return subprocess.CompletedProcess(args, 0, "mock success", "")

    def test_dry_run_no_http_children_or_output_directories(self):
        self.coverage("book")
        self.assertEqual(BATCH.main(["--dry-run"]), 0)
        self.assertFalse(self.out.exists())
        self.child.assert_not_called()
        self.http.assert_not_called()
        BATCH.health_preflight.assert_not_called()

    def test_historical_quarantine_and_opt_in_preserve_old_files(self):
        self.coverage("book")
        scope = self.historical()
        old = {p.name: p.read_bytes() for p in scope.iterdir()}
        self.assertEqual(BATCH.main([]), 1)
        self.assertIn("review_required", self.output.getvalue())
        self.child.assert_not_called()
        self.assertEqual(BATCH.main(["--rerun-incomplete"]), 0)
        self.assertEqual(self.child.call_count, 1)
        for name, data in old.items():
            self.assertEqual((scope / name).read_bytes(), data)
        self.assertTrue(BATCH.complete("book"))
        self.assertEqual(BATCH.main([]), 0)
        self.assertEqual(self.child.call_count, 1)

    def test_child_nonzero_overrides_strict_success_no_retry(self):
        self.coverage("book")
        def nonzero(args, **kwargs):
            result = self.child_success(args, **kwargs)
            result.returncode = 7
            return result
        self.child.side_effect = nonzero
        self.assertEqual(BATCH.main([]), 1)
        self.assertEqual(self.child.call_count, 1)
        scope = self.out / "book"
        self.assertFalse((scope / "selected_attempt.json").exists())
        self.assertEqual(len(list((scope / "attempts").iterdir())), 1)
        self.assertIn("done=0", self.output.getvalue())

    def test_rc_zero_with_legacy_or_invalid_report_fails(self):
        self.coverage("book")
        def invalid(args, **kwargs):
            result = self.child_success(args, **kwargs)
            path = Path(args[args.index("--out-dir") + 1])
            write_json(path / "validation_report.json", {"ok": True})
            return result
        self.child.side_effect = invalid
        self.assertEqual(BATCH.main([]), 1)
        self.assertEqual(self.child.call_count, 1)

    def test_budget_incomplete_returns_nonzero_without_dispatch(self):
        self.coverage("a", "b")
        self.assertEqual(BATCH.main(["0"]), 1)
        self.child.assert_not_called()
        self.assertFalse(self.out.exists())
        self.assertIn("remaining=2", self.output.getvalue())

    def test_budget_checked_between_books(self):
        self.coverage("a", "b")
        clock = [0]
        def run(args, **kwargs):
            result = self.child_success(args, **kwargs)
            clock[0] = 10
            return result
        self.child.side_effect = run
        with mock.patch.object(BATCH.time, "monotonic", side_effect=lambda: clock[0]):
            self.assertEqual(BATCH.main(["5"]), 1)
        self.assertEqual(self.child.call_count, 1)
        self.assertIn("remaining=1", self.output.getvalue())

    def test_failed_attempt_then_explicit_retry_has_unique_accounting(self):
        self.coverage("book")
        def failure(args, **kwargs):
            result = self.child_success(args, **kwargs)
            result.returncode = 1
            return result
        self.child.side_effect = failure
        self.assertEqual(BATCH.main([]), 1)
        scope = self.out / "book"
        old = {p: p.read_bytes() for p in scope.rglob("*") if p.is_file()}
        self.child.side_effect = self.child_success
        self.assertEqual(BATCH.main([]), 1)  # no implicit retry on next invocation
        self.assertEqual(self.child.call_count, 1)
        self.assertEqual(BATCH.main(["--rerun-incomplete"]), 0)
        self.assertEqual(self.child.call_count, 2)
        self.assertEqual(len(list((scope / "attempts").iterdir())), 2)
        for path, data in old.items():
            self.assertEqual(path.read_bytes(), data)
        self.assertIn("done=1 no_work=0 already_ok=0 failed=0 remaining=0", self.output.getvalue())

    def test_no_work_is_not_counted_as_extraction(self):
        self.coverage("book")
        def no_work(args, **kwargs):
            write_report(Path(args[args.index("--out-dir") + 1]), no_work=True)
            return subprocess.CompletedProcess(args, 0, "mock no-work", "")
        self.child.side_effect = no_work
        self.assertEqual(BATCH.main([]), 0)
        self.assertIn("done=0 no_work=1", self.output.getvalue())

    def test_failure_stops_serial_submission(self):
        self.coverage("a", "b")
        self.child.side_effect = OSError("mock child failure")
        self.assertEqual(BATCH.main([]), 1)
        self.assertEqual(self.child.call_count, 1)
        self.assertIn("failed=1 remaining=1", self.output.getvalue())

    def test_invalid_generator_profile_fails_even_dry_run(self):
        self.coverage("book")
        with mock.patch.dict(os.environ, {"CANARY_GEN_PROFILE": "typo"}):
            self.assertEqual(BATCH.main(["--dry-run"]), 1)
        self.child.assert_not_called()

    def test_reverify_dry_run_and_lineage_skip_then_changed_source(self):
        scope = self.historical()
        self.assertEqual(REVERIFY.main(["--books", "book,book", "--dry-run"]), 0)
        self.child.assert_not_called()
        self.assertFalse((scope / "reverify_8001").exists())
        self.assertEqual(REVERIFY.main(["--books", "book,book"]), 0)
        self.assertEqual(self.child.call_count, 1)
        self.assertFalse((scope / "selected_attempt.json").exists())
        self.assertTrue(REVERIFY.complete("book"))
        self.assertEqual(REVERIFY.main(["--books", "book"]), 0)
        self.assertEqual(self.child.call_count, 1)
        (scope / "proposition_generator.jsonl").write_bytes(b"changed\n")
        self.assertFalse(REVERIFY.complete("book"))
        self.assertEqual(evidence.selection_integrity_status(scope / "reverify_8001"), "intact")
        self.assertEqual(REVERIFY.main(["--books", "book"]), 0)
        self.assertEqual(self.child.call_count, 2)
        self.assertEqual(len(list((scope / "reverify_8001" / "selection_history").iterdir())), 2)

    def test_broken_reverify_pointer_or_history_is_quarantined_across_repeated_invocations(self):
        for index, corruption in enumerate(("malformed_pointer", "invalid_schema", "wrong_purpose", "traversal", "history_tamper",
                                             "history_missing", "pointer_missing", "job_tamper", "report_tamper")):
            with self.subTest(corruption=corruption):
                book = "book" + str(index)
                scope = self.historical(book) / "reverify_8001"
                self.assertEqual(REVERIFY.main(["--books", book]), 0)
                pointer = scope / "selected_attempt.json"
                pointer_bytes = pointer.read_bytes()
                record = json.loads(pointer_bytes)
                history = scope / "selection_history" / (hashlib.sha256(pointer_bytes).hexdigest() + ".json")
                if corruption == "malformed_pointer":
                    pointer.write_bytes(b"{")
                elif corruption in {"invalid_schema", "wrong_purpose", "traversal"}:
                    if corruption == "invalid_schema":
                        record["selection_version"] = True
                    elif corruption == "wrong_purpose":
                        record["purpose"] = "generator"
                    else:
                        record["selected_path"] = "../escape"
                    data = evidence.json_bytes(record)
                    (scope / "selection_history" / (hashlib.sha256(data).hexdigest() + ".json")).write_bytes(data)
                    pointer.write_bytes(data)
                elif corruption == "history_tamper":
                    history.write_bytes(b"{}")
                elif corruption == "history_missing":
                    history.unlink()
                elif corruption == "pointer_missing":
                    pointer.unlink()
                else:
                    filename = "job_record.json" if corruption == "job_tamper" else "validation_report.json"
                    target = scope / record["selected_path"] / filename
                    target.write_bytes(target.read_bytes() + b" ")
                before = {p.relative_to(scope): p.read_bytes() for p in scope.rglob("*") if p.is_file()}
                attempts_before = list((scope / "attempts").iterdir())
                self.child.reset_mock()
                REVERIFY.health_preflight.reset_mock()
                self.assertEqual(evidence.selection_integrity_status(scope, purpose="reverify"), "broken")
                for args in (["--dry-run"], [], []):
                    self.assertEqual(REVERIFY.main(["--books", book] + args), 1)
                self.child.assert_not_called()
                REVERIFY.health_preflight.assert_not_called()
                self.http.assert_not_called()
                self.assertEqual(list((scope / "attempts").iterdir()), attempts_before)
                self.assertEqual({p.relative_to(scope): p.read_bytes() for p in scope.rglob("*") if p.is_file()}, before)

    def test_broken_reverify_superseded_history_is_quarantined(self):
        scope = self.historical() / "reverify_8001"
        self.assertEqual(REVERIFY.main(["--books", "book"]), 0)
        old_pointer = (scope / "selected_attempt.json").read_bytes()
        (scope.parent / "proposition_generator.jsonl").write_bytes(b"changed\n")
        self.assertEqual(REVERIFY.main(["--books", "book"]), 0)
        old_history = scope / "selection_history" / (hashlib.sha256(old_pointer).hexdigest() + ".json")
        old_history.write_bytes(b"{}")
        self.child.reset_mock()
        for _ in range(2):
            self.assertEqual(REVERIFY.main(["--books", "book"]), 1)
        self.child.assert_not_called()

    def test_broken_wavea_selection_never_dispatches_even_with_explicit_rerun(self):
        self.coverage("book")
        self.assertEqual(BATCH.main([]), 0)
        pointer = self.out / "book" / "selected_attempt.json"
        pointer.write_bytes(b"{}")
        self.child.reset_mock()
        for _ in range(2):
            self.assertEqual(BATCH.main(["--rerun-incomplete"]), 1)
        self.child.assert_not_called()

    def test_artifact_tamper_prevents_scheduler_completion_and_child_success_selection(self):
        self.coverage("book")
        def tampered(args, **kwargs):
            result = self.child_success(args, **kwargs)
            path = Path(args[args.index("--out-dir") + 1])
            (path / "proposition_verifier.jsonl").write_bytes(b"tampered\n")
            return result
        self.child.side_effect = tampered
        self.assertEqual(BATCH.main([]), 1)
        self.assertFalse(BATCH.complete("book"))
        self.assertFalse((self.out / "book" / "selected_attempt.json").exists())

    def test_tampered_selected_generator_is_never_reverified_or_replaced_by_legacy_input(self):
        self.coverage("book")
        self.historical()
        self.assertEqual(BATCH.main(["--rerun-incomplete"]), 0)
        source = REVERIFY.generator_source("book")
        source.write_bytes(b"tampered generator\n")
        self.assertFalse(BATCH.complete("book"))
        self.child.reset_mock()
        for _ in range(2):
            self.assertEqual(REVERIFY.main(["--books", "book"]), 1)
        self.child.assert_not_called()

    def test_reverify_uses_selected_generation_and_never_legacy_on_bad_pointer(self):
        self.coverage("book")
        scope = self.historical()
        self.assertEqual(BATCH.main(["--rerun-incomplete"]), 0)
        source = REVERIFY.generator_source("book")
        self.assertIn("attempts", source.parts)
        original = (scope / "selected_attempt.json").read_bytes()
        self.assertEqual(REVERIFY.main(["--books", "book"]), 0)
        self.assertEqual((scope / "selected_attempt.json").read_bytes(), original)
        (scope / "selected_attempt.json").write_bytes(b"{}")
        with self.assertRaisesRegex(ValueError, "refusing legacy fallback"):
            REVERIFY.generator_source("book")
        calls = self.child.call_count
        self.assertEqual(REVERIFY.main(["--books", "book"]), 1)
        self.assertEqual(self.child.call_count, calls)

    def test_reverify_rc_mismatch_and_invalid_report_are_failures(self):
        scope = self.historical()
        def nonzero(args, **kwargs):
            result = self.child_success(args, **kwargs)
            result.returncode = 2
            return result
        self.child.side_effect = nonzero
        self.assertEqual(REVERIFY.main(["--books", "book"]), 1)
        self.assertFalse((scope / "reverify_8001" / "selected_attempt.json").exists())
        self.assertEqual(self.child.call_count, 1)
        def wrong_lineage(args, **kwargs):
            result = self.child_success(args, **kwargs)
            write_report(Path(args[args.index("--out-dir") + 1]), reverify_hash=HASH)
            return result
        self.child.side_effect = wrong_lineage
        self.assertEqual(REVERIFY.main(["--books", "book"]), 1)
        self.assertEqual(self.child.call_count, 2)
        self.assertEqual(len(list((scope / "reverify_8001" / "attempts").iterdir())), 2)


class PreflightTests(unittest.TestCase):
    def test_job_expectations_tracks_current_inputs_config_and_source(self):
        from tools import proposition_canary_run as core
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base = root / "scheduler"
            book_root = root / "runs" / "book" / core._WAVEA[0]
            sources = {
                "coverage_partition.jsonl": base / core._WAVEA_COVERAGE_ROOT / "book" / "coverage_partition.jsonl",
                "sentences.jsonl": book_root / core._WAVEA[1],
                core.GEN_PROMPT: base / core.GEN_PROMPT,
                core.VER_PROMPT_CONTRACT: base / core.VER_PROMPT_CONTRACT,
                "source_proposition_audit_gates_v1.json": base / "source_proposition_audit_gates_v1.json",
            }
            for path in sources.values():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"fixture\n")
            runner = root / "runner.py"
            runner.write_bytes(b"fixture runner\n")
            generator = root / "generator.jsonl"
            generator.write_bytes(b"fixture generator\n")
            config = root / "worker_config.json"
            write_json(config, {"profiles": BATCH.PROFILE_EXPECTATIONS})
            with mock.patch.object(BATCH, "REPO", str(root)), \
                 mock.patch.object(BATCH, "HERE", str(base)), \
                 mock.patch.object(BATCH, "RUNNER", str(runner)), \
                 mock.patch.dict(os.environ, {"CANARY_GEN_PROFILE": "structured_source"}):
                expected, context = BATCH.job_expectations("book")
                self.assertEqual(expected["expected_input_hashes"],
                                 {k: evidence.file_sha256(v) for k, v in sources.items()})
                sources["sentences.jsonl"].write_bytes(b"changed\n")
                changed, changed_context = BATCH.job_expectations("book")
                self.assertNotEqual(expected, changed)
                self.assertNotEqual(context, changed_context)
                config.write_bytes(config.read_bytes() + b"\n")
                _, config_context = BATCH.job_expectations("book")
                self.assertNotEqual(changed_context, config_context)
                runner.write_bytes(b"new runner\n")
                _, runner_context = BATCH.job_expectations("book")
                self.assertNotEqual(config_context, runner_context)
                reverify, _ = BATCH.job_expectations("book", source_generator=generator)
                self.assertEqual(reverify["expected_source_generator_hash"], evidence.file_sha256(generator))
                # A stale source pointer must not silently fall back to old sentences.
                (book_root / ".d01_sentences_path").write_text(str(root / "missing.jsonl"))
                with self.assertRaises(FileNotFoundError):
                    BATCH.job_expectations("book")

    def test_supervisor_has_serial_defaults_and_no_batch_retry_loop(self):
        script = (ROOT / "runs" / "_extraction_scheduler" / "20260924" / "run_wavea_supervisor.sh").read_text(encoding="utf-8")
        self.assertIn("JOBS=${CANARY_JOBS:-1}", script)
        self.assertIn("batch.book_plan(books)", script)
        dispatch = script.index('python3 -B -u "$BATCH"')
        self.assertGreater(script.rindex("done"), script.index("while :; do"))
        self.assertLess(script.rindex("done"), dispatch)
        self.assertNotIn("while", script[dispatch:])
        self.assertIn('if [ "$rc" -ne 0 ]; then exit "$rc"; fi', script[dispatch:])
        self.assertIn('exec python3 -B "$BATCH" --dry-run', script[:dispatch])

    def test_actual_model_identity_not_http_status_alone(self):
        profiles = {k: dict(v) for k, v in BATCH.PROFILE_EXPECTATIONS.items()}
        def response(model):
            result = mock.MagicMock()
            result.__enter__.return_value = result
            result.status = 200
            result.read.return_value = json.dumps({"data": [{"id": model}]}).encode()
            return result
        with mock.patch.dict(os.environ, {"CANARY_GEN_PROFILE": "structured_source"}), \
             mock.patch.object(BATCH, "load_canary_profiles", return_value=profiles):
            opener = mock.Mock(return_value=response("wrong-model"))
            with self.assertRaisesRegex(SystemExit, "missing model"):
                BATCH.health_preflight(opener)
            opener = mock.Mock(side_effect=lambda *args, **kwargs: response(BATCH.MODEL_ID))
            BATCH.health_preflight(opener)
            self.assertEqual(opener.call_count, 2)
            for call in opener.call_args_list:
                self.assertEqual(call.args[0].get_method(), "GET")
                self.assertTrue(call.args[0].full_url.endswith("/v1/models"))


if __name__ == "__main__":
    unittest.main()
