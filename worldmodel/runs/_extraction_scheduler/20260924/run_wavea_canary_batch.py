#!/usr/bin/env python3
"""run_wavea_canary_batch.py -- batch driver for the wave-A proposition canary.

Runs `tools/proposition_canary_run.py` (generator -> independent verifier ->
validated route queues + audit sample) over every book that has a deterministic
coverage partition in `c01_coverage_partition_wavea_v1`. Books whose
`validation_report.json` already reports `ok: true` are skipped; incomplete
output dirs are reset first (the runner is absent-only).

No promotion. result_class = proposition_canary_measurement. review_only.

Usage:
  DISABLE_LLM_THINKING=1 python3 run_wavea_canary_batch.py [budget_seconds] \
      [--books a,b,c] [--limit N] [--dry-run]

  budget_seconds : stop after this many seconds (default 3000). Use to run the
                   ~20k-call set across multiple sessions; it resumes.
"""
import argparse, json, os, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
COV = os.path.join(HERE, "c01_coverage_partition_wavea_v1")
OUTROOT = os.path.join(HERE, "proposition_canary_v1")
RUNNER = os.path.join(REPO, "tools", "proposition_canary_run.py")
LOG = os.path.join(OUTROOT, "_wavea_batch_log.jsonl")
MODEL_ID = "/scratch/yl15858/qwen/Qwen3-27B"
NO_WORK_STATUS = "no_eligible_windows"
PROFILE_EXPECTATIONS = {
    "structured_source": {
        "endpoint": "http://localhost:8000/v1/chat/completions",
        "model": MODEL_ID,
    },
    "unstructured_analysis": {
        "endpoint": "http://localhost:8001/v1/chat/completions",
        "model": MODEL_ID,
    },
}


def load_canary_profiles():
    with open(os.path.join(REPO, "worker_config.json"), encoding="utf-8") as handle:
        profiles = json.load(handle).get("profiles", {})
    return {name: profiles.get(name) for name in PROFILE_EXPECTATIONS}


def validation_status(book):
    vr = os.path.join(OUTROOT, book, "validation_report.json")
    if not os.path.exists(vr):
        return None
    try:
        with open(vr, encoding="utf-8") as handle:
            report = json.load(handle)
    except Exception:
        return None
    if report.get("ok") is not True:
        return None
    status = report.get("status", "completed")
    return status if status in {"completed", NO_WORK_STATUS} else None


def complete(book):
    return validation_status(book) is not None


def health_preflight(opener):
    """Verify configured endpoint identities using GET /v1/models only."""
    profiles = load_canary_profiles()
    bad = []
    for name, expected in PROFILE_EXPECTATIONS.items():
        profile = profiles.get(name)
        if not isinstance(profile, dict):
            bad.append(f"{name}=missing_profile")
            continue
        for key, value in expected.items():
            if profile.get(key) != value:
                bad.append(f"{name}.{key}={profile.get(key)!r}, expected={value!r}")
    if bad:
        raise SystemExit("FAIL: configured canary profiles do not match the endpoint contract: " + "; ".join(bad))

    import urllib.request
    for name, expected in PROFILE_EXPECTATIONS.items():
        models_url = expected["endpoint"].replace("/chat/completions", "/models")
        request = urllib.request.Request(models_url, method="GET")
        try:
            with opener(request, timeout=8) as response:
                status = response.status
                raw = response.read()
            if status != 200:
                bad.append(f"{name} {models_url}=HTTP {status}")
                continue
            payload = json.loads(raw.decode("utf-8"))
            data = payload.get("data")
            if not isinstance(data, list):
                raise ValueError("missing data list")
            model_ids = [entry.get("id") for entry in data
                         if isinstance(entry, dict) and isinstance(entry.get("id"), str)]
            if expected["model"] not in model_ids:
                bad.append(f"{name} {models_url} missing model {expected['model']!r}; returned={model_ids!r}")
        except Exception as exc:
            bad.append(f"{name} {models_url}={type(exc).__name__}: {exc}")
    if bad:
        raise SystemExit("FAIL: endpoint identity preflight failed: " + "; ".join(bad))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("budget", nargs="?", type=float, default=3000.0)
    ap.add_argument("--books", default=None, help="comma-separated subset")
    ap.add_argument("--limit", type=int, default=0, help="run only first N eligible books")
    ap.add_argument("--jobs", type=int, default=1,
                    help="concurrent book runners (<= :8001 max_num_seqs=8; keep 1 for generator-only serial)")
    ap.add_argument("--dry-run", action="store_true", help="print plan; no dispatch")
    a = ap.parse_args()

    all_books = [d for d in sorted(os.listdir(COV))
                 if os.path.exists(os.path.join(COV, d, "coverage_partition.jsonl"))]
    if a.books:
        want = {b.strip() for b in a.books.split(",") if b.strip()}
        all_books = [b for b in all_books if b in want]
    if a.limit:
        all_books = all_books[:a.limit]

    todo = [b for b in all_books if not complete(b)]
    print(f"[plan] eligible={len(all_books)} todo={len(todo)} already_ok={len(all_books)-len(todo)}")
    if a.dry_run:
        for b in todo:
            print("  ", b)
        return 0

    if os.environ.get("DISABLE_LLM_THINKING") != "1":
        raise SystemExit("FAIL: export DISABLE_LLM_THINKING=1 before dispatching")

    import urllib.request
    health_preflight(urllib.request.urlopen)

    import threading
    start = time.time()
    done, failed, skipped = [], [], len(all_books) - len(todo)
    lock = threading.Lock()
    stop = threading.Event()

    def run_book(book):
        if stop.is_set():
            return
        out = os.path.join(OUTROOT, book)
        if os.path.exists(out):
            shutil.rmtree(out)
        t = time.time()
        proc = subprocess.run([sys.executable, RUNNER, "--book", book],
                              capture_output=True, text=True, encoding="utf-8")
        status = validation_status(book)
        ok = status is not None
        lines = ((proc.stdout or "") + (proc.stderr or "")).strip().splitlines()
        rec = {"book": book, "ok": ok, "rc": proc.returncode,
               "status": status,
               "sec": round(time.time() - t, 1), "tail": " | ".join(lines[-4:]),
               "err": "" if ok else next((x for x in reversed(lines) if "FAIL" in x or "Error" in x or "Traceback" in x), "")}
        with lock:
            os.makedirs(OUTROOT, exist_ok=True)
            with open(LOG, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            if status == NO_WORK_STATUS:
                skipped += 1
                print(f"[no-work] {book} {rec['sec']}s {rec['tail']}", flush=True)
            elif ok:
                done.append(book)
                print(f"[ok] {book} {rec['sec']}s {rec['tail']}", flush=True)
            else:
                failed.append(book)
                print(f"[FAIL] {book} rc={proc.returncode} {rec['err']}", flush=True)
        if time.time() - start > a.budget:
            stop.set()

    if a.jobs <= 1:
        for book in todo:
            if stop.is_set():
                print(f"[budget] stop; done={len(done)} skipped={skipped} failed={len(failed)}", flush=True)
                break
            run_book(book)
    else:
        from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
        it = iter(todo)
        with ThreadPoolExecutor(max_workers=a.jobs) as ex:
            futs = set()

            def fill():
                while len(futs) < a.jobs and not stop.is_set():
                    try:
                        b = next(it)
                    except StopIteration:
                        break
                    futs.add(ex.submit(run_book, b))

            fill()
            while futs:
                d, _ = wait(futs, return_when=FIRST_COMPLETED)
                for f in d:
                    futs.discard(f)
                    f.result()
                fill()
    print(f"[end] done={len(done)} skipped={skipped} failed={len(failed)} elapsed={time.time()-start:.0f}s", flush=True)
    if failed:
        print("FAILED:", failed, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
