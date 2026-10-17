#!/usr/bin/env bash
# Health waiting is allowed ONLY before one batch. Never retry a failed batch.
# Historical evidence remains quarantined; explicit reruns use the batch CLI.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$HERE/../../.." && pwd)
cd "$REPO"
export DISABLE_LLM_THINKING=1
export PYTHONPATH="$REPO:$HERE${PYTHONPATH:+:$PYTHONPATH}"
BATCH="$HERE/run_wavea_canary_batch.py"
JOBS=${CANARY_JOBS:-1}
BUDGET=${CANARY_BUDGET:-3000}
if [ "$#" -ne 0 ]; then
  if [ "$#" -eq 1 ] && [ "$1" = "--dry-run" ]; then
    exec python3 -B "$BATCH" --dry-run
  fi
  echo 'Usage: run_wavea_supervisor.sh [--dry-run]; explicit historical reruns use the batch CLI' >&2
  exit 2
fi

# The same selection/report helper used by the batch decides completion.
# No directories or logs are created by planning or health waiting.
set +e
python3 -B - <<'PY'
import os
import run_wavea_canary_batch as batch
batch.gen_profile_name()
books = [b for b in sorted(os.listdir(batch.COV))
         if os.path.isfile(os.path.join(batch.COV, b, 'coverage_partition.jsonl'))]
plan = batch.book_plan(books)
review = [r['book'] for r in plan if r['state'] == 'review_required']
print('[supervisor] review_required=' + ','.join(review), flush=True)
if not any(r['dispatch'] for r in plan):
    raise SystemExit(2 if review else 0)
raise SystemExit(3)  # newly missing books only
PY
plan_rc=$?
set -e
case "$plan_rc" in
  0) echo '[supervisor] all books strictly selected; exiting'; exit 0 ;;
  3) ;;
  *) echo '[supervisor] review/configuration required; stopping' >&2; exit 1 ;;
esac

while :; do
  set +e
  python3 -B - <<'PY'
import os
import urllib.request
import run_wavea_canary_batch as batch
try:
    batch.gen_profile_name()
    profiles = batch.load_canary_profiles()
    for name, expected in batch.active_expectations().items():
        if any(profiles.get(name, {}).get(k) != v for k, v in expected.items()):
            raise ValueError('configured profile mismatch: ' + name)
except Exception as exc:
    print('[supervisor] configuration failure: ' + str(exc), flush=True)
    raise SystemExit(2)
try:
    batch.health_preflight(urllib.request.urlopen)
except SystemExit as exc:
    # Retain the existing explicit degraded opt-in, never silently switch.
    if (os.environ.get('CANARY_ALLOW_DEGRADED') == '1'
            and batch.gen_profile_name() == 'structured_source'):
        os.environ['CANARY_GEN_PROFILE'] = 'unstructured_analysis'
        try:
            batch.health_preflight(urllib.request.urlopen)
        except SystemExit:
            pass
        else:
            raise SystemExit(3)
    print(str(exc), flush=True)
    raise SystemExit(1)
PY
  health_rc=$?
  set -e
  case "$health_rc" in
    0) break ;;
    3) export CANARY_GEN_PROFILE=unstructured_analysis
       echo '[supervisor] explicit CANARY_ALLOW_DEGRADED=1: degraded_generation_unstructured_analysis'
       break ;;
    1) echo '[supervisor] waiting on endpoint identity/health before work'; sleep 30 ;;
    *) echo '[supervisor] invalid configuration; stopping' >&2; exit 1 ;;
  esac
done

set +e
python3 -B -u "$BATCH" "$BUDGET" --jobs "$JOBS"
rc=$?
set -e
echo "[supervisor] batch exited rc=$rc; no automatic retry"
if [ "$rc" -ne 0 ]; then exit "$rc"; fi
python3 -B "$BATCH" --check-complete
