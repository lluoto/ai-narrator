import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def load_module(name, relative_path):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


CANARY = load_module("proposition_canary_run_test", "tools/proposition_canary_run.py")
BATCH = load_module(
    "run_wavea_canary_batch_test",
    "runs/_extraction_scheduler/20260924/run_wavea_canary_batch.py",
)
MODEL_ID = "/scratch/yl15858/qwen/Qwen3-27B"
VERDICT = {
    "case_id": "case-1",
    "overall": "entailed",
    "checks": [],
    "no_runtime_effect": True,
}


class VerdictBlockParserTests(unittest.TestCase):
    def verdict_block(self, body=None):
        return "<VERDICT_JSON>\n%s\n</VERDICT_JSON>" % json.dumps(body or VERDICT)

    def test_plain_verdict_is_accepted(self):
        parsed, errors = CANARY.parse_verdict_block(self.verdict_block())
        self.assertEqual(parsed, VERDICT)
        self.assertEqual(errors, [])

    def test_thought_prefixed_verdict_is_accepted_after_literal_marker(self):
        content = "<think>reasoning response text</think>\n" + self.verdict_block()
        parsed, errors = CANARY.parse_verdict_block(content)
        self.assertEqual(parsed, VERDICT)
        self.assertEqual(errors, [])

    def test_duplicate_verdict_blocks_are_rejected(self):
        parsed, errors = CANARY.parse_verdict_block(self.verdict_block() + "\n" + self.verdict_block())
        self.assertIsNone(parsed)
        self.assertEqual(errors, ["verdict_block_duplicate"])

    def test_trailing_content_is_rejected(self):
        parsed, errors = CANARY.parse_verdict_block(self.verdict_block() + "\nextra output")
        self.assertIsNone(parsed)
        self.assertEqual(errors, ["verdict_block_trailing"])

    def test_malformed_json_is_rejected(self):
        parsed, errors = CANARY.parse_verdict_block("<VERDICT_JSON>{not json}</VERDICT_JSON>")
        self.assertIsNone(parsed)
        self.assertEqual(errors, ["verdict_block_malformed"])


class FakeResponse:
    def __init__(self, status, payload):
        self.status = status
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class BatchPreflightTests(unittest.TestCase):
    def test_preflight_requires_each_profile_model_identity_without_chat_calls(self):
        requests = []

        def opener(request, timeout):
            requests.append(request)
            return FakeResponse(200, {"data": [{"id": MODEL_ID}]})

        profiles = {
            name: dict(expected) for name, expected in BATCH.PROFILE_EXPECTATIONS.items()
        }
        with mock.patch.object(BATCH, "load_canary_profiles", return_value=profiles):
            BATCH.health_preflight(opener)

        self.assertEqual(
            [request.full_url for request in requests],
            ["http://localhost:8000/v1/models", "http://localhost:8001/v1/models"],
        )
        self.assertTrue(all(request.get_method() == "GET" for request in requests))

    def test_preflight_rejects_an_unexpected_model_identity(self):
        profiles = {
            name: dict(expected) for name, expected in BATCH.PROFILE_EXPECTATIONS.items()
        }

        def opener(request, timeout):
            return FakeResponse(200, {"data": [{"id": "/scratch/other/Qwen3-27B"}]})

        with mock.patch.object(BATCH, "load_canary_profiles", return_value=profiles):
            with self.assertRaisesRegex(SystemExit, "missing model"):
                BATCH.health_preflight(opener)


class NoEligibleCoverageTests(unittest.TestCase):
    def test_no_eligible_windows_is_complete_without_candidate_output_or_network(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            repo = Path(temporary_directory) / "repo"
            base = repo / "runs" / "_extraction_scheduler" / "20260924"
            book = "no-work-book"
            coverage = base / "c01_coverage_partition_wavea_v1" / book / "coverage_partition.jsonl"
            coverage.parent.mkdir(parents=True)
            coverage.write_text(json.dumps({"window_id": "W1", "role": "other"}) + "\n", encoding="utf-8")
            sentences = repo / "runs" / book / "source_bound_wavea_v1" / "source_index_wavea_v1" / "sentences_clean_v1.jsonl"
            sentences.parent.mkdir(parents=True)
            sentences.write_text("", encoding="utf-8")
            prompts = base / "proposition_canary_prompts"
            prompts.mkdir(parents=True)
            for name in (CANARY.GEN_PROMPT, CANARY.VER_PROMPT_CONTRACT):
                (base / name).write_text("[SYSTEM]\nsystem\n[USER]\nuser\n", encoding="utf-8")
            (base / "source_proposition_audit_gates_v1.json").write_text("{}\n", encoding="utf-8")
            config = {
                "profiles": {
                    "structured_source": {
                        "endpoint": "http://localhost:8000/v1/chat/completions",
                        "model": MODEL_ID,
                        "thinking_disabled": True,
                        "max_num_seqs": 1,
                        "max_tokens": 1500,
                    },
                    "unstructured_analysis": {
                        "endpoint": "http://localhost:8001/v1/chat/completions",
                        "model": MODEL_ID,
                    },
                },
            }
            (repo / "worker_config.json").parent.mkdir(parents=True, exist_ok=True)
            (repo / "worker_config.json").write_text(json.dumps(config), encoding="utf-8")
            out_root = Path(temporary_directory) / "out"
            scope = out_root / book
            out_dir = BATCH.allocate_attempt(scope)

            with mock.patch.object(CANARY, "REPO", str(repo)), \
                 mock.patch.object(CANARY, "BASE", str(base)), \
                 mock.patch.object(CANARY, "call_model", side_effect=AssertionError("network call")), \
                 mock.patch.dict(CANARY.os.environ, {"DISABLE_LLM_THINKING": "1"}), \
                 mock.patch.object(sys, "argv", ["proposition_canary_run.py", "--book", book, "--out-dir", str(out_dir)]):
                self.assertEqual(CANARY.main(), 0)

            report = json.loads((out_dir / "validation_report.json").read_text(encoding="utf-8"))
            self.assertEqual(report["status"], "no_eligible_windows")
            self.assertTrue(report["ok"])
            self.assertFalse(report["candidate_output_written"])
            self.assertEqual(
                sorted(path.name for path in out_dir.iterdir()),
                ["job_record.json", "validation_report.json"],
            )
            context = "a" * 64
            with mock.patch.object(BATCH, "OUTROOT", str(out_root)), \
                 mock.patch.object(BATCH, "job_expectations", return_value=({}, context)):
                self.assertFalse(BATCH.complete(book))
                BATCH.select_attempt(scope, out_dir, context_sha256=context)
                self.assertTrue(BATCH.complete(book))
                self.assertEqual(BATCH.validation_status(book), BATCH.NO_WORK_STATUS)

    def test_legacy_root_success_is_not_an_explicit_validated_selection(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            book = "legacy-book"
            scope = root / book
            scope.mkdir()
            (scope / "validation_report.json").write_text(
                json.dumps({"ok": True, "status": "completed"}), encoding="utf-8")
            self.assertEqual(BATCH.validated_report_status(scope), "legacy_unvalidated")
            with mock.patch.object(BATCH, "OUTROOT", str(root)), \
                 mock.patch.object(BATCH, "job_expectations", return_value=({}, "a" * 64)):
                self.assertFalse(BATCH.complete(book))


if __name__ == "__main__":
    unittest.main()
