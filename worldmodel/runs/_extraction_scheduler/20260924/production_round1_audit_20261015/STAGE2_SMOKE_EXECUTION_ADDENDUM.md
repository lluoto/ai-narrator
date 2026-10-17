# Stage 2 Bounded Smoke Execution Addendum

## Offline Review

Reviewed the separate inference session's frozen report:

```text
runs/_extraction_scheduler/20260924/proposition_smoke_v1/STAGE1_OFFLINE_PREP.md
```

The six declared runner/config/prompt/gate hashes match. Both scoped coverage
files match their declared hashes; all five selected rows are byte-identical to
their parent coverage rows. At review time both reserved output paths were
absent. No model or health request was made by the reviewing session.

Read-only reproduction:

```text
python3 -B runs/_extraction_scheduler/20260924/production_round1_audit_20261015/verify_smoke_stage1.py
```

This verifies the frozen preparation only. Source-resolution preflight and
health/model checks remain required by the inference owner before calling Qwen.

## Correction To Stage 1 Command Block

`--coverage-root` is relative to the scheduler base, not the repository root.
The original report's value starting `runs/_extraction_scheduler/20260924/`
would be joined twice. Use `proposition_smoke_v1/coverage` as below.

Force `CANARY_GEN_PROFILE=structured_source` so an inherited degraded-profile
environment cannot move generation onto 8001. Check each book's exit status:
the first book's failure MUST prevent the second book from dispatching.

## Bounded Execution Scope

The preparation meets the offline prerequisites for this bounded live smoke:

```text
5 generation windows, 2 works
8000 generation requests: at most 5
8001 verification requests: at most 15 (three cards/window)
completion requests total: at most 20
serial; no automatic retries; no bulk follow-on
```

Only the separate inference owner executes, once the existing inference slot
is available under that owner's coordination. Do not stop/restart an active
job or start a competing batch to run this smoke. If it is already running or
an output path exists, do not issue these commands again.

## Corrected WSL Commands (Inference Owner Only)

Run from `/mnt/d/aitrpg/世界模型/worldmodel`. Before execution, the inference
owner must compare both `/v1/models` responses with the frozen config's exact
model `/scratch/yl15858/qwen/Qwen3-27B`; a mismatch blocks all completion calls.

```bash
export DISABLE_LLM_THINKING=1
export CANARY_GEN_PROFILE=structured_source
CROOT=proposition_smoke_v1/coverage
SMOKE=runs/_extraction_scheduler/20260924/proposition_smoke_v1
OUT_A="$SMOKE/不死冥神/attempts/02491bfd6ed74afd9e661bca0a823bf6/output"
OUT_B="$SMOKE/网游之亡者征途/attempts/a28723c688c74418bf3c90760a12b4ed/output"

# Preparation only: refuses changed pins, validates source bindings, no HTTP.
python3 -B runs/_extraction_scheduler/20260924/production_round1_audit_20261015/verify_smoke_stage1.py &&
test ! -e "$OUT_A" && test ! -e "$OUT_B" &&
python3 -B tools/proposition_canary_run.py --book '不死冥神' \
  --coverage-root "$CROOT" --out-dir "$OUT_A" --dry-run &&
python3 -B tools/proposition_canary_run.py --book '网游之亡者征途' \
  --coverage-root "$CROOT" --out-dir "$OUT_B" --dry-run
```

Only after the preparation and the owner-performed model-health checks succeed:

```bash
python3 -B tools/proposition_canary_run.py --book '不死冥神' \
  --coverage-root "$CROOT" --out-dir "$OUT_A" \
  --max-tokens 1500 --ver-max-tokens 16000 &&
python3 -B tools/inspect_proposition_attempt.py --attempt "$(pwd)/$OUT_A" &&
python3 -B tools/proposition_canary_run.py --book '网游之亡者征途' \
  --coverage-root "$CROOT" --out-dir "$OUT_B" \
  --max-tokens 1500 --ver-max-tokens 16000 &&
python3 -B tools/inspect_proposition_attempt.py --attempt "$(pwd)/$OUT_B"
```

`&&` is intentional: any first-book or postflight failure blocks book two.
Never use `--overwrite`, an automatic retry loop, or `--rerun-incomplete` for
this smoke. Return exact output paths and any failed raw-capture references.

## Interpretation

Historical supported/insufficient/contradiction/empty/unresolved case names are
selection strata, not mandatory outcomes. Fresh generation may select different
claims or no claims. Record which intended scenarios actually occurred; do not
force a verdict or count an unexercised scenario as tested. Passing execution
validates protocol/accounting only; semantic quality still requires review.

The Stage 1 statement `147 passed` should be read against actual offline suite
evidence: 147 tests run, 146 passed, one host-capability skip, zero failures.

All outputs remain candidate/review-only. No production result is overwritten,
no original/reverify precedence is selected, no runtime effect is granted, and
no full batch is authorized by this smoke.
