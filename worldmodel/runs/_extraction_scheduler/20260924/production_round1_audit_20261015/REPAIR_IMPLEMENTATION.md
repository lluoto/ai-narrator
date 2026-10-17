# First-Round Runner Repair

## Scope

These changes repair deterministic acceptance and audit integrity only. The
first-round artifacts are unchanged. No inference, model health request,
production restart, process termination, or bulk regeneration was performed.
No runtime authority, promotion, or quality certification is introduced.

## Implemented

- `tools/proposition_canary_run.py`: strict response model/choice/stop contract;
  one HTTP attempt; raw-first durable request/response capture including partial
  HTTP bodies; fail-stop with explicit remaining work; complete source preflight;
  strict card types and supplied-evidence-only citations; all eight semantic
  checks and deterministic overall reconciliation.
- Versioned verifier prompt:
  `proposition_canary_prompts/proposition_verifier_prompt_v3_acceptance_contract_2.txt`
  beneath the scheduler directory. Old prompts are unchanged. This new prompt
  has offline contract tests but has NOT been validated by a live Qwen smoke.
- Reverify requires a complete valid generator snapshot and original source
  bindings. Verifier-only failures remain repairable; invalid generation and
  rejected cards cannot vanish from the denominator of a completed reverify.
- New reports declare `acceptance_contract_version=2`, separate generation,
  execution and verification completeness, explicit failure/unattempted counts,
  and `quality_certified=false` even when execution succeeds.
- Final jobs pin their output tree, including raw call evidence and empty queues.
- `tools/proposition_attempts.py`: hash-bound selection, append-only selection
  history, new absent-only attempt paths, and full output integrity checks.
- Batch/reverify drivers no longer delete evidence or automatically retry. They
  require successful child termination AND valid v2 evidence, return nonzero
  for unresolved failures/incomplete work, and default to serial execution.
- Supervisor shares the strict completion contract and exits after batch error,
  rather than repeatedly resubmitting contract failures.
- `tools/select_effective_verification.py`: offline explicit per-card selection;
  no timestamp/positive-verdict preference and no fallback. It validates selected
  generator/verifier files against job output hashes and selected raw captures.
  Missing historical contract evidence remains `unverified`.

## Historical Interpretation

Historical `ok=true` means only what the historical runner checked. It is not
silently rewritten or accepted under the new contract. The default batch plan
quarantines those books as `review_required`; it does NOT regenerate them.

The first-round audit's original/reverify partitions remain historical counts,
not current semantically certified results. The 713 differing statuses have not
been resolved. The 457 verifier repair entries are attempt rows, not necessarily
457 distinct candidates. No-work books remain distinct from extraction coverage.

Do not use `--rerun-incomplete` across all historical books merely to make the
new scheduler green. That explicitly permits fresh whole-book generation and
would waste usable first-round generator evidence.

## Verification

From the worldmodel root:

```text
python -B -m unittest discover -s tests -v
```

Latest offline suite including postflight and optional offline optimizations:
331 tests, 329 passed, 2 host-capability skips, 0 failures. See
`OFFLINE_OPTIMIZATION_STATUS.md` for the new tools and compatibility limits.
The skip concerns creating real filesystem symlinks; mocked symlink rejection
coverage runs. All network and child-dispatch paths in execution tests use mocks.

Historical audit replay is separately available:

```text
python -B audit_round1.py --check
```

Run that command from this audit directory. It verifies existing audit products
without writes and does not invoke a production runner or a model.

After this repair, the historical byte-for-byte replay reports
`input_hashes.jsonl` mismatch because that inventory includes the three repaired
runner source files. The frozen audit is not rewritten to conceal the change.
Use this separate read-only check to distinguish those code changes from any
unexpected changes to the audited inputs:

```text
python -B verify_repair_input_integrity.py
```

Only the exact three repaired runner paths are classified as code changes;
any other changed or missing audited file returns nonzero and is listed.
The post-repair check found 2,706 inventoried files: 2,703 byte-identical files,
exactly those three repaired runner files changed, and zero unexpected changes.

## Next Inference Work

Qwen calls, retries, and batch scheduling belong to the separate model/session
responsible for inference. Use the new bounded handoff:

```text
runs/_extraction_scheduler/20260924/handoff_qwen_acceptance_v2_validation.md
```

`tools/inspect_proposition_attempt.py --attempt <absolute-output-directory>` is
the read-only postflight entry point. It never dispatches Qwen or starts/stops
workers. Pending or unstable output is not a completed or failed model result;
only sealed strict-v2 evidence can pass. Return the exact output path from the
inference session for this check.

Bulk semantic discovery remains assigned to the user-specified Luna executor:

```text
runs/_extraction_scheduler/20260924/handoff_round1_bulk_discovery_gpt6_luna.md
```

No live quality improvement is claimed by the offline fixes. An already-loaded
process has not been restarted; a later subprocess or import may read the new
on-disk runner. Coordinate any subsequent dispatch with the inference owner.
