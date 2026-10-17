"""Run unit-test modules in separate processes, not the production pipeline.

Usage (from the repository root)::

    python -B tools/run_offline_unittests.py
    python -B tools/run_offline_unittests.py --module test_offline_unittest_launcher.py
    python -B tools/run_offline_unittests.py --timeout 600 --log offline-unittests.log

Children run serially, once each. No files are written unless --log is given.
Existing offline fixtures use mock transports; this harness does not enforce or
prove provider/network isolation. model_calls describes the launcher only.
Counts come from complete terminal unittest summaries, not progress characters;
passed is max(0, tests - skipped - failures - errors), including for subtests.
If a summary is missing, aggregate counts are explicitly incomplete.
"""

import argparse
from contextlib import ExitStack
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
SUMMARY = re.compile(
    r"^-{5,}\nRan ([0-9]+) tests? in [0-9]+(?:\.[0-9]+)?s\n\n"
    r"(OK(?: \(skipped=[0-9]+\))?|FAILED \([^\n]+\))\n?\Z",
    re.MULTILINE,
)


def parse_summary(stdout, stderr):
    """Accept one complete terminal summary, on either captured stream."""
    matches = [match for stream in (stdout, stderr)
               if (match := SUMMARY.search(stream.replace("\r\n", "\n")))]
    if len(matches) != 1:
        return None
    match = matches[0]
    status = match[2]
    counts = dict(tests=int(match[1]), skipped=0, failures=0, errors=0)
    if "(" in status:
        fields = status[status.index("(") + 1:-1].split(", ")
        seen = set()
        for field in fields:
            part = re.fullmatch(r"(skipped|failures|errors)=([0-9]+)", field)
            if not part or part[1] in seen:
                return None
            seen.add(part[1])
            counts[part[1]] = int(part[2])
    if status.startswith("OK"):
        if counts["skipped"] > counts["tests"]:
            return None
    elif not (counts["failures"] or counts["errors"]):
        return None
    counts["passed"] = max(0, counts["tests"] - counts["skipped"]
                           - counts["failures"] - counts["errors"])
    return counts


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter,
                                     allow_abbrev=False)
    parser.add_argument("--module", help="One exact test_*.py basename in root/tests")
    parser.add_argument("--timeout", type=float, default=600,
                        help="Timeout in seconds per file (default: 600)")
    parser.add_argument("--log", type=Path, help="Optional full UTF-8 transcript (overwritten)")
    args = parser.parse_args(argv)
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("--timeout must be finite and positive")
    testdir = ROOT / "tests"
    files = sorted(path.name for path in testdir.glob("test_*.py") if path.is_file())
    if args.module is not None:
        if args.module not in files or any(c in args.module for c in "/\\*?[]"):
            parser.error("--module must be an exact discovered test_*.py basename")
        files = [args.module]
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    totals = dict(tests=0, passed=0, skipped=0, failures=0, errors=0)
    failed_files = []
    missing = 0
    with ExitStack() as stack:
        log = stack.enter_context(args.log.open("w", encoding="utf-8")) if args.log else None

        def emit(text):
            print(text, end="", flush=True)
            if log is not None:
                log.write(text)
                log.flush()

        for filename in files:
            command = [sys.executable, "-B", "-m", "unittest", "discover",
                       "-s", str(testdir), "-p", filename]
            emit("\n=== " + filename + " ===\n")
            reason = None
            returncode = None
            stdout = stderr = ""
            try:
                child = subprocess.run(command, cwd=str(ROOT), timeout=args.timeout,
                                       capture_output=True, env=env)
                stdout, stderr = child.stdout, child.stderr
                returncode = child.returncode
                if returncode != 0:
                    reason = "child_exit_" + str(returncode)
            except subprocess.TimeoutExpired as exc:
                stdout, stderr = exc.stdout or b"", exc.stderr or b""
                reason = "timeout"
            except OSError as exc:
                reason = "spawn_failure: " + str(exc)
            streams = []
            for label, output in (("stdout", stdout), ("stderr", stderr)):
                text = output.decode("utf-8", errors="backslashreplace") if isinstance(output, bytes) else output
                streams.append(text)
                if text:
                    emit("--- " + label + " ---\n" + text + ("" if text.endswith("\n") else "\n"))
            counts = parse_summary(*streams)
            if counts is None:
                missing += 1
                reason = reason or "missing_or_invalid_terminal_summary"
            else:
                for key in totals:
                    totals[key] += counts[key]
                if counts["failures"] or counts["errors"]:
                    reason = reason or "unittest_failure"
            if reason is not None:
                failed_files.append(filename)
            emit(json.dumps(dict(file=filename, status="failed" if reason else "passed",
                                 reason=reason, returncode=returncode, counts=counts),
                            ensure_ascii=False) + "\n")
        summary = dict(python_version=sys.version.split()[0], files=len(files),
                       files_passed=len(files) - len(failed_files),
                       files_failed=len(failed_files), failed_files=failed_files,
                       files_without_summary=missing, counts_complete=missing == 0,
                       model_calls="not_dispatched_by_launcher", **totals)
        if not files:
            summary["error"] = "no_test_modules_found"
        emit("\nSUMMARY " + json.dumps(summary, ensure_ascii=False) + "\n")
    return int(bool(failed_files) or not files)


if __name__ == "__main__":
    raise SystemExit(main())
