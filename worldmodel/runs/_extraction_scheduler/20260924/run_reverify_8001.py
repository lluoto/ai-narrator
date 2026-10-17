#!/usr/bin/env python3
"""Independent :8001 reverify, immutable outputs and explicit source lineage.

Selected generator output is preferred. A historical root generator file can
be an INPUT ONLY when no generator pointer exists. A broken pointer never
falls back to root. Reverify selection stays inside book/reverify_8001; it
does not publish an effective result or replace the generator selection.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.dont_write_bytecode = True
if HERE not in sys.path:
    sys.path.insert(0, HERE)
from run_wavea_canary_batch import (
    SUCCESS_STATUSES, allocate_attempt, gen_profile_name, health_preflight,
    job_expectations, safe_book, select_attempt, selected_attempt, selection_integrity_status, validated_report_status,
)

RUNNER = os.path.join(REPO, "tools", "proposition_canary_run.py")
OUTROOT = os.path.join(HERE, "proposition_canary_v1")
LOG = os.path.join(OUTROOT, "_reverify_8001_log.jsonl")
DEFAULT_BOOKS = [
    "三国大领主", "80天征服魔都", "不死冥神", "乾坤", "亡灵召唤",
    "传奇博物馆", "传奇大英雄", "全球论战",
]


def generator_source(book):
    safe_book(book)
    scope = Path(OUTROOT) / book
    if scope.is_symlink():
        raise ValueError("symlink book scope")
    if selection_integrity_status(scope, purpose="generator") == "broken":
        raise ValueError("broken generator selection; refusing legacy fallback")
    if os.path.lexists(scope / "selected_attempt.json"):
        expected, context = job_expectations(book)
        attempt = selected_attempt(scope, context_sha256=context, **expected)
        if attempt is None:
            raise ValueError("invalid/stale generator selection; refusing legacy fallback")
        source = attempt / "proposition_generator.jsonl"
    else:
        source = scope / "proposition_generator.jsonl"
    if source.is_symlink() or not source.is_file():
        raise ValueError("missing/unsafe generator input")
    return source


def complete(book):
    try:
        source = generator_source(book)
        expected, context = job_expectations(book, source_generator=source)
        return selected_attempt(Path(OUTROOT) / book / "reverify_8001",
                                context_sha256=context, purpose="reverify", **expected) is not None
    except (OSError, ValueError, KeyError, TypeError):
        return False


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--jobs", type=int, default=1)
    ap.add_argument("--books", help="comma-separated subset")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    if a.jobs < 1 or a.limit < 0:
        ap.error("jobs must be positive; limit must be nonnegative")
    books = list(dict.fromkeys(b.strip() for b in a.books.split(",") if b.strip())) if a.books else list(DEFAULT_BOOKS)
    if a.limit:
        books = books[:a.limit]
    todo, failed, already = [], {}, []
    try:
        gen_profile_name()  # reject typos rather than silently degrading
    except ValueError as exc:
        print(f"[FAIL] {exc}")
        return 1
    for book in books:
        try:
            safe_book(book)
            scope = Path(OUTROOT) / book / "reverify_8001"
            if selection_integrity_status(scope, purpose="reverify") == "broken":
                raise ValueError("broken reverify selection pointer/history; review required")
            source = generator_source(book)
            expected, context = job_expectations(book, source_generator=source)
            scope = Path(OUTROOT) / book / "reverify_8001"
            if selected_attempt(scope, context_sha256=context, purpose="reverify", **expected) is not None:
                already.append(book)
                print(f"[plan] {book} already_ok")
            else:
                todo.append((book, source, expected, context))
                print(f"[plan] {book} fresh_reverify source={source}")
        except (OSError, ValueError, KeyError, TypeError) as exc:
            failed[book] = str(exc)
            print(f"[plan] {book} FAIL {exc}")
    print(f"[plan] books={len(books)} todo={len(todo)} already_ok={len(already)} failed={len(failed)} jobs={a.jobs}")
    if a.dry_run:
        return int(bool(failed))
    if not todo:
        return int(bool(failed))
    if os.environ.get("DISABLE_LLM_THINKING") != "1":
        raise SystemExit("FAIL: export DISABLE_LLM_THINKING=1 before dispatching")
    import urllib.request
    health_preflight(urllib.request.urlopen, verifier_only=True)
    lock = threading.Lock()
    results = {}

    def run_book(item):
        book, source, expected, context = item
        attempt = None
        started = time.monotonic()
        rc = -1
        status = "invalid"
        lines = []
        try:
            # Detect queued source/config changes before dispatch as well as after.
            current, current_context = job_expectations(book, source_generator=source)
            if current != expected or current_context != context:
                raise ValueError("source/config changed before reverify")
            scope = Path(OUTROOT) / book / "reverify_8001"
            if selection_integrity_status(scope, purpose="reverify") == "broken":
                raise ValueError("broken reverify selection pointer/history; review required")
            attempt = allocate_attempt(scope)
            proc = subprocess.run(
                [sys.executable, "-u", RUNNER, "--book", book, "--verifier-only",
                 "--gen-jsonl", str(source), "--out-dir", str(attempt)],
                capture_output=True, text=True, encoding="utf-8",
                env=dict(os.environ, DISABLE_LLM_THINKING="1"))
            rc = proc.returncode
            lines = ((proc.stdout or "") + (proc.stderr or "")).strip().splitlines()
            status = validated_report_status(attempt, **expected)
            current, current_context = job_expectations(book, source_generator=source)
            if current != expected or current_context != context or generator_source(book) != source:
                raise ValueError("source/config changed during reverify")
            ok = rc == 0 and status in SUCCESS_STATUSES
            if ok:
                select_attempt(scope, attempt, context_sha256=context, purpose="reverify", **expected)
        except Exception as exc:
            ok = False
            lines.append(f"{type(exc).__name__}: {exc}")
        rec = {"book": book, "ok": ok, "rc": rc, "status": status,
               "attempt": str(attempt), "source_generator": str(source),
               "source_generator_sha256": expected["expected_source_generator_hash"],
               "sec": round(time.monotonic() - started, 1), "tail": " | ".join(lines[-3:])}
        with lock:
            results[book] = rec
            try:
                with open(LOG, "a", encoding="utf-8") as handle:
                    handle.write(json.dumps(rec, ensure_ascii=True) + "\n")
            except OSError as exc:
                rec["ok"] = False
                rec["tail"] += f" log failure: {exc}"
            print(f"[{'ok' if rec['ok'] else 'FAIL'}] {book} rc={rc} {rec['tail']}", flush=True)
        return rec["ok"]

    # No retry pass. Stop submitting after an error; in-flight work is preserved.
    with ThreadPoolExecutor(max_workers=a.jobs) as pool:
        pending = {}
        items = iter(todo)
        stop = False
        from concurrent.futures import wait, FIRST_COMPLETED
        while True:
            while not stop and len(pending) < a.jobs:
                item = next(items, None)
                if item is None:
                    break
                pending[pool.submit(run_book, item)] = item[0]
            if not pending:
                break
            finished, _ = wait(pending, return_when=FIRST_COMPLETED)
            for future in finished:
                book = pending.pop(future)
                try:
                    if not future.result():
                        stop = True
                except Exception as exc:
                    failed[book] = str(exc)
                    stop = True
    failed.update({b: r["tail"] for b, r in results.items() if not r["ok"]})
    remaining = {item[0] for item in todo} - results.keys() - failed.keys()
    done = sum(r["ok"] for r in results.values())
    print(f"[end] reverified={done} already_ok={len(already)} failed={len(failed)} remaining={len(remaining)}")
    return int(bool(failed or remaining))


if __name__ == "__main__":
    raise SystemExit(main())
