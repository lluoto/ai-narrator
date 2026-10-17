"""Launcher regressions: every child process and optional log is mocked."""

import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "offline_unittest_launcher", ROOT / "tools/run_offline_unittests.py")
LAUNCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAUNCHER)


def output(tests=3, status="OK", prefix=""):
    noun = "test" if tests == 1 else "tests"
    return (prefix + "\n----------------------------------------------------------------------\n"
            + f"Ran {tests} {noun} in 0.001s\n\n{status}\n").encode("utf-8")


class LauncherTests(unittest.TestCase):
    def invoke(self, names, children, args=()):
        paths = [mock.Mock(name=name) for name in names]
        for path, name in zip(paths, names):
            path.name = name
            path.is_file.return_value = True
        stream = io.StringIO()
        with mock.patch.object(Path, "glob", return_value=paths) as glob, \
             mock.patch.object(LAUNCHER.subprocess, "run", side_effect=children) as run, \
             mock.patch.object(Path, "open") as opened, \
             mock.patch.object(sys, "stdout", stream):
            code = LAUNCHER.main(list(args))
        lines = stream.getvalue().splitlines()
        summary = json.loads(next(line[8:] for line in lines if line.startswith("SUMMARY ")))
        records = [json.loads(line) for line in lines if line.startswith('{"file":')]
        return code, summary, records, run, opened, stream.getvalue(), glob

    def child(self, status="OK", tests=3, code=0, stdout=b"", stderr=None):
        return subprocess.CompletedProcess([], code, stdout,
                                           output(tests, status) if stderr is None else stderr)

    def test_sorted_serial_explicit_commands_and_complete_aggregate(self):
        code, summary, rows, run, opened, _, glob = self.invoke(
            ["test_z.py", "test_offline_unittest_launcher.py", "test_a.py"],
            [self.child(tests=4), self.child("OK (skipped=2)", tests=3),
             self.child(tests=1)])
        self.assertEqual(code, 0)
        self.assertEqual([r["file"] for r in rows],
                         ["test_a.py", "test_offline_unittest_launcher.py", "test_z.py"])
        for call, row in zip(run.call_args_list, rows):
            self.assertEqual(call.args, ([sys.executable, "-B", "-m", "unittest",
                                         "discover", "-s", str(ROOT / "tests"),
                                         "-p", row["file"]],))
            self.assertEqual(call.kwargs["cwd"], str(ROOT))
            self.assertEqual(call.kwargs["timeout"], 600)
            self.assertTrue(call.kwargs["capture_output"])
            self.assertEqual(call.kwargs["env"]["PYTHONIOENCODING"], "utf-8")
        self.assertEqual({k: summary[k] for k in ("tests", "passed", "skipped", "failures", "errors")},
                         dict(tests=8, passed=6, skipped=2, failures=0, errors=0))
        self.assertEqual(summary["files_passed"], 3)
        self.assertEqual(summary["files_failed"], 0)
        self.assertTrue(summary["counts_complete"])
        self.assertEqual(summary["python_version"], sys.version.split()[0])
        self.assertEqual(summary["model_calls"], "not_dispatched_by_launcher")
        opened.assert_not_called()
        glob.assert_called_once_with("test_*.py")

    def test_failure_counts_and_full_output_continue_without_retries(self):
        details = "fixture traceback\n" + "x" * 10000 + "\n"
        code, summary, rows, run, _, transcript, _ = self.invoke(
            ["test_a.py", "test_b.py"],
            [self.child(tests=6, code=1, stdout=b"stdout detail\n",
                        stderr=output(6, "FAILED (failures=1, errors=2, skipped=1)", details)),
             self.child(tests=2)])
        self.assertEqual(code, 1)
        self.assertEqual(run.call_count, 2)
        self.assertEqual(summary["failed_files"], ["test_a.py"])
        self.assertEqual(summary["tests"], 8)
        self.assertEqual(summary["passed"], 4)
        self.assertEqual(summary["failures"], 1)
        self.assertEqual(summary["errors"], 2)
        self.assertEqual(summary["skipped"], 1)
        self.assertIn(details, transcript)
        self.assertIn("stdout detail\n", transcript)
        self.assertEqual(rows[0]["reason"], "child_exit_1")

    def test_missing_truncated_and_unknown_summaries_fail_closed(self):
        invalid = [b"", b"OK\n", output()[:-3], output() + b"trailing output\n",
                   output(status="OK (expected failures=1)"),
                   output(status="FAILED (unexpected successes=1)"),
                   output(status="OK (skipped=4)"),
                   output(status="FAILED (failures=1, failures=1)"),
                   output(status="FAILED (errors=0)"),
                   output(status="OK (skipped=-1)")]
        for data in invalid:
            with self.subTest(data=data):
                code, summary, rows, _, _, _, _ = self.invoke(
                    ["test_a.py"], [self.child(stderr=data)])
                self.assertEqual(code, 1)
                self.assertFalse(summary["counts_complete"])
                self.assertEqual(summary["files_without_summary"], 1)
                self.assertIsNone(rows[0]["counts"])

    def test_nonzero_signal_or_failed_summary_never_pass(self):
        for child in (self.child(code=2), self.child(code=-9),
                      self.child("FAILED (failures=1)", code=0)):
            with self.subTest(child=child):
                result = self.invoke(["test_a.py"], [child])
                self.assertEqual(result[0], 1)
                self.assertEqual(result[1]["files_passed"], 0)

    def test_timeout_preserves_partial_unicode_and_continues(self):
        text = "\u4e16\u754c\u6a21\u578b: \u6d4b\u8bd5\u8f93\u51fa\n"
        timeout = subprocess.TimeoutExpired(["unit-test"], 12,
                                            output=text.encode("utf-8"), stderr=b"partial stderr")
        code, summary, rows, run, _, transcript, _ = self.invoke(
            ["test_a.py", "test_b.py"], [timeout, self.child()], ["--timeout", "12"])
        self.assertEqual(code, 1)
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args.kwargs["timeout"], 12)
        self.assertEqual(rows[0]["reason"], "timeout")
        self.assertEqual(summary["files_passed"], 1)
        self.assertIn(text, transcript)
        self.assertNotIn("\\u4e16", transcript)
        self.assertIn("partial stderr", transcript)

    def test_timeout_even_with_complete_summary_and_spawn_failure(self):
        for exc in (subprocess.TimeoutExpired(["unit-test"], 1, stderr=output()),
                    OSError("fixture spawn failure")):
            with self.subTest(exc=exc):
                result = self.invoke(["test_a.py"], [exc])
                self.assertEqual(result[0], 1)
                self.assertEqual(result[1]["files_passed"], 0)
                self.assertEqual(result[3].call_count, 1)

    def test_literal_unicode_stdout_and_optional_utf8_log(self):
        text = "\u4e16\u754c\u6a21\u578b \u6d4b\u8bd5\n"
        result = self.invoke(["test_a.py"], [self.child(stdout=text.encode("utf-8"))],
                             ["--log", "fixture.log"])
        self.assertEqual(result[0], 0)
        self.assertIn(text, result[5])
        result[4].assert_called_once_with("w", encoding="utf-8")
        handle = result[4].return_value.__enter__.return_value
        self.assertEqual("".join(c.args[0] for c in handle.write.call_args_list), result[5])

    def test_summary_on_stdout_crlf_singular_and_subtest_counts(self):
        self.assertEqual(LAUNCHER.parse_summary(output(1).decode().replace("\n", "\r\n"), "")["passed"], 1)
        self.assertEqual(LAUNCHER.parse_summary("", output(1, "FAILED (failures=2)").decode())["passed"], 0)
        self.assertIsNone(LAUNCHER.parse_summary(output().decode(), output().decode()))

    def test_exact_module_selection_including_self_never_spawns_real_children(self):
        result = self.invoke(["test_a.py", "test_offline_unittest_launcher.py"],
                             [self.child()], ["--module", "test_offline_unittest_launcher.py"])
        self.assertEqual(result[0], 0)
        self.assertEqual(result[3].call_count, 1)
        self.assertEqual(result[3].call_args.args[0][-1], "test_offline_unittest_launcher.py")

    def test_invalid_cli_never_launches_children_or_opens_logs(self):
        invalid = [["--module", value] for value in
                   ("../test_a.py", "tests/test_a.py", "tests\\test_a.py", "test_*.py", "test_absent.py")]
        invalid += [["--timeout", value] for value in ("0", "-1", "nan", "inf")]
        invalid += [["--dispatch"], ["--pattern", "test_*.py"], ["--", "arbitrary-command"]]
        for args in invalid:
            with self.subTest(args=args), mock.patch.object(sys, "stderr", io.StringIO()), \
                 mock.patch.object(Path, "glob", return_value=[ROOT / "tests/test_offline_unittest_launcher.py"]), \
                 mock.patch.object(LAUNCHER.subprocess, "run") as run, \
                 mock.patch.object(Path, "open") as opened:
                with self.assertRaises(SystemExit) as raised:
                    LAUNCHER.main(args)
                self.assertEqual(raised.exception.code, 2)
                run.assert_not_called()
                opened.assert_not_called()

    def test_no_modules_is_failure(self):
        result = self.invoke([], [])
        self.assertEqual(result[0], 1)
        self.assertEqual(result[1]["error"], "no_test_modules_found")
        result[3].assert_not_called()


if __name__ == "__main__":
    unittest.main()
