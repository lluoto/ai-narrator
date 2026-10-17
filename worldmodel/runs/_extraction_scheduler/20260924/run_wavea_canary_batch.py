#!/usr/bin/env python3
"""One immutable attempt per book per invocation; no implicit retry/promotion.

Existing unselected, legacy, failed or stale evidence is review_required and
requires explicit --rerun-incomplete consent. The flag never deletes artifacts.
--dry-run is read-only and performs no HTTP, including health checks.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.dont_write_bytecode = True
if REPO not in sys.path:
    sys.path.insert(0, REPO)
from tools.proposition_attempts import (
    SUCCESS_STATUSES, allocate_attempt, file_sha256, json_bytes,
    select_attempt, selected_attempt, selection_integrity_status, validated_report_status,
)

COV = os.path.join(HERE, "c01_coverage_partition_wavea_v1")
OUTROOT = os.path.join(HERE, "proposition_canary_v1")
RUNNER = os.path.join(REPO, "tools", "proposition_canary_run.py")
LOG = os.path.join(OUTROOT, "_wavea_batch_log.jsonl")
MODEL_ID = "/scratch/yl15858/qwen/Qwen3-27B"
NO_WORK_STATUS = "no_eligible_windows"
PROFILE_EXPECTATIONS = {
    "structured_source": {"endpoint": "http://localhost:8000/v1/chat/completions", "model": MODEL_ID},
    "unstructured_analysis": {"endpoint": "http://localhost:8001/v1/chat/completions", "model": MODEL_ID},
}


def gen_profile_name():
    name = os.environ.get("CANARY_GEN_PROFILE", "structured_source")
    if name not in PROFILE_EXPECTATIONS:
        raise ValueError("invalid CANARY_GEN_PROFILE: " + name)
    return name


def load_canary_profiles():
    with open(os.path.join(REPO, "worker_config.json"), encoding="utf-8") as handle:
        return json.load(handle).get("profiles", {})


def active_expectations():
    gen = gen_profile_name()
    names = ("structured_source", "unstructured_analysis") if gen == "structured_source" else (gen,)
    return {name: PROFILE_EXPECTATIONS[name] for name in names}


def health_preflight(opener, *, verifier_only=False):
    """GET /v1/models, checking configured and actual model identities."""
    import urllib.request
    expected_profiles = ({"unstructured_analysis": PROFILE_EXPECTATIONS["unstructured_analysis"]}
                         if verifier_only else active_expectations())
    profiles = load_canary_profiles()
    bad = []
    for name, expected in expected_profiles.items():
        profile = profiles.get(name)
        if not isinstance(profile, dict):
            bad.append(name + "=missing_profile")
            continue
        for key, value in expected.items():
            if profile.get(key) != value:
                bad.append(f"{name}.{key}={profile.get(key)!r}, expected={value!r}")
    if bad:
        raise SystemExit("FAIL: configured canary profiles do not match the endpoint contract: " + "; ".join(bad))
    for name, expected in expected_profiles.items():
        url = expected["endpoint"].replace("/chat/completions", "/models")
        try:
            with opener(urllib.request.Request(url, method="GET"), timeout=8) as response:
                if response.status != 200:
                    raise ValueError(f"HTTP {response.status}")
                data = json.loads(response.read().decode("utf-8")).get("data")
            if not isinstance(data, list):
                raise ValueError("missing data list")
            ids = [entry.get("id") for entry in data if isinstance(entry, dict)]
            if expected["model"] not in ids:
                raise ValueError(f"missing model {expected['model']!r}; returned={ids!r}")
        except Exception as exc:
            bad.append(f"{name} {url}={type(exc).__name__}: {exc}")
    if bad:
        raise SystemExit("FAIL: endpoint identity preflight failed: " + "; ".join(bad))


def safe_book(book):
    if not book or book in {".", ".."} or any(c in book for c in "/\\:"):
        raise ValueError("unsafe book name")
    scope = Path(OUTROOT) / book
    if scope.is_symlink():
        raise ValueError("symlink book scope")
    return scope


def job_expectations(book, *, source_generator=None):
    """Read-only snapshot of the runner's default inputs and execution config."""
    from tools import proposition_canary_run as core
    gen = gen_profile_name()
    version, sentences_rel = core.BOOKS.get(book, core._WAVEA)
    book_root = Path(REPO) / "runs" / book / version
    sentences = book_root / sentences_rel
    pointer = book_root / ".d01_sentences_path"
    if book not in core.BOOKS and pointer.exists():
        pointed = pointer.read_text(encoding="utf-8").strip()
        if pointed:
            sentences = Path(pointed)
    coverage_root = core.COVERAGE_ROOT if book in core.BOOKS else core._WAVEA_COVERAGE_ROOT
    paths = {
        "coverage_partition.jsonl": Path(HERE) / coverage_root / book / "coverage_partition.jsonl",
        "sentences.jsonl": sentences,
        core.GEN_PROMPT: Path(HERE) / core.GEN_PROMPT,
        core.VER_PROMPT_CONTRACT: Path(HERE) / core.VER_PROMPT_CONTRACT,
        "source_proposition_audit_gates_v1.json": Path(HERE) / "source_proposition_audit_gates_v1.json",
    }
    hashes = {name: file_sha256(path) for name, path in paths.items()}
    profiles = load_canary_profiles()
    fields = {"book": book, "verifier_endpoint": profiles["unstructured_analysis"]["endpoint"],
              "verifier_model": profiles["unstructured_analysis"]["model"]}
    if source_generator is None:
        fields.update(generator_profile=gen, endpoint=profiles[gen]["endpoint"], model=profiles[gen]["model"])
    expected = {"expected_input_hashes": hashes, "expected_job_fields": fields}
    context = {"inputs": hashes, "job_fields": fields, "runner_sha256": file_sha256(RUNNER),
               "worker_config_sha256": file_sha256(Path(REPO) / "worker_config.json")}
    if source_generator is not None:
        source_hash = file_sha256(source_generator)
        expected["expected_source_generator_hash"] = source_hash
        context["source_generator_sha256"] = source_hash
    return expected, hashlib.sha256(json_bytes(context)).hexdigest()


def validation_status(book):
    try:
        expected, context = job_expectations(book)
        attempt = selected_attempt(safe_book(book), context_sha256=context, **expected)
        return validated_report_status(attempt, **expected) if attempt else None
    except (OSError, ValueError, KeyError, TypeError):
        return None


def complete(book):
    return validation_status(book) in SUCCESS_STATUSES


def book_plan(books, rerun_incomplete=False):
    records = []
    for book in dict.fromkeys(books):
        scope = safe_book(book)
        integrity = selection_integrity_status(scope, purpose="generator")
        status = validation_status(book) if integrity == "intact" else None
        state = status if status in SUCCESS_STATUSES else ("review_required" if scope.exists() else "missing")
        records.append({"book": book, "state": state,
                        "selection_integrity": integrity,
                        "dispatch": integrity != "broken" and (state == "missing" or (state == "review_required" and rerun_incomplete))})
    return records


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("budget", nargs="?", type=float, default=3000.0)
    ap.add_argument("--books", help="comma-separated subset")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--jobs", type=int, default=1)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--rerun-incomplete", action="store_true", help="explicit opt-in to NEW attempts for existing books")
    ap.add_argument("--check-complete", action="store_true", help="read-only strict completion check; no HTTP")
    a = ap.parse_args(argv)
    if a.jobs < 1 or a.budget < 0 or a.limit < 0:
        ap.error("jobs must be positive; budget/limit must be nonnegative")
    try:
        gen = gen_profile_name()
        books = [d for d in sorted(os.listdir(COV))
                 if os.path.isfile(os.path.join(COV, d, "coverage_partition.jsonl"))]
        if a.books:
            want = {b.strip() for b in a.books.split(",") if b.strip()}
            if want - set(books):
                raise ValueError("unknown books: " + ",".join(sorted(want - set(books))))
            books = [b for b in books if b in want]
        if a.limit:
            books = books[:a.limit]
        plan = book_plan(books, a.rerun_incomplete)
    except (OSError, ValueError) as exc:
        print(f"[FAIL] {exc}", flush=True)
        return 1
    todo = [r["book"] for r in plan if r["dispatch"]]
    review = [r["book"] for r in plan if r["state"] == "review_required" and not r["dispatch"]]
    already = [r["book"] for r in plan if r["state"] in SUCCESS_STATUSES]
    print(f"[plan] books={len(plan)} todo={len(todo)} already_ok={len(already)} review_required={len(review)} jobs={a.jobs}")
    print(f"[plan] generator_profile={gen} execution_mode=" +
          ("structured_source" if gen == "structured_source" else "degraded_generation_unstructured_analysis"))
    for record in plan:
        print(f"[plan] {record['book']} {record['state']} dispatch={record['dispatch']}")
    if a.dry_run:
        return 0
    if a.check_complete:
        return int(len(already) != len(plan))
    if not todo:
        return int(bool(review))
    if a.budget == 0:
        print(f"[end] remaining={len(todo)} budget exhausted")
        return 1
    if os.environ.get("DISABLE_LLM_THINKING") != "1":
        raise SystemExit("FAIL: export DISABLE_LLM_THINKING=1 before dispatching")
    import urllib.request
    health_preflight(urllib.request.urlopen)
    start = time.monotonic()
    results = {}
    lock = threading.Lock()

    def run_book(book):
        started = time.monotonic()
        attempt = None
        rc = -1
        status = "invalid"
        lines = []
        try:
            expected, context = job_expectations(book)
            if selection_integrity_status(safe_book(book), purpose="generator") == "broken":
                raise ValueError("broken selection pointer/history; review required")
            attempt = allocate_attempt(safe_book(book))
            proc = subprocess.run([sys.executable, RUNNER, "--book", book, "--out-dir", str(attempt)],
                                  capture_output=True, text=True, encoding="utf-8")
            rc = proc.returncode
            lines = ((proc.stdout or "") + (proc.stderr or "")).strip().splitlines()
            status = validated_report_status(attempt, **expected)
            current_expected, current_context = job_expectations(book)
            if context != current_context or expected != current_expected:
                raise ValueError("source/config changed during attempt")
            ok = rc == 0 and status in SUCCESS_STATUSES
            if ok:
                select_attempt(safe_book(book), attempt, context_sha256=context, **expected)
        except Exception as exc:
            ok = False
            lines.append(f"{type(exc).__name__}: {exc}")
        rec = {"book": book, "ok": ok, "rc": rc, "status": status, "attempt": str(attempt),
               "generator_profile": gen, "sec": round(time.monotonic() - started, 1), "tail": " | ".join(lines[-4:])}
        with lock:
            results[book] = rec
            # Log failures without deleting or resetting any attempt artifacts.
            try:
                Path(OUTROOT).mkdir(parents=True, exist_ok=True)
                with open(LOG, "a", encoding="utf-8") as handle:
                    handle.write(json.dumps(rec, ensure_ascii=True) + "\n")
            except OSError as exc:
                rec["ok"] = False
                rec["tail"] += f" log failure: {exc}"
            label = ("no-work" if status == NO_WORK_STATUS else "ok") if rec["ok"] else "FAIL"
            print(f"[{label}] {book} rc={rc} {rec['tail']}", flush=True)
        return rec["ok"]

    # Bounded submission respects the budget before starting each new book.
    pending_books = iter(todo)
    stop = False
    with ThreadPoolExecutor(max_workers=a.jobs) as pool:
        pending = {}
        while True:
            while not stop and len(pending) < a.jobs and time.monotonic() - start < a.budget:
                book = next(pending_books, None)
                if book is None:
                    break
                pending[pool.submit(run_book, book)] = book
            if not pending:
                break
            finished, _ = wait(pending, return_when=FIRST_COMPLETED)
            for future in finished:
                book = pending.pop(future)
                try:
                    if not future.result():
                        stop = True
                except Exception as exc:
                    results[book] = {"ok": False, "status": "driver_error"}
                    print(f"[FAIL] {book}: {exc}", flush=True)
                    stop = True
    failed = [b for b, r in results.items() if not r["ok"]]
    done = [b for b, r in results.items() if r["ok"] and r["status"] == "completed"]
    no_work = [b for b, r in results.items() if r["ok"] and r["status"] == NO_WORK_STATUS]
    remaining = set(todo) - results.keys()
    print(f"[end] done={len(done)} no_work={len(no_work)} already_ok={len(already)} "
          f"failed={len(failed)} remaining={len(remaining)} review_required={len(review)}", flush=True)
    return int(bool(failed or remaining or review))


if __name__ == "__main__":
    raise SystemExit(main())
