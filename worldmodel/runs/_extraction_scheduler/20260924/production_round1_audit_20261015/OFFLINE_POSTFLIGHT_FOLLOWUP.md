# Offline Postflight Follow-Up

## Execution Boundary

This follow-up changes only offline inspection, attempt selection, effective
selection and their tests. No Qwen health/completion request, production runner,
process control, restart or batch dispatch was performed. Active attempt outputs
were not inspected or modified during these tests.

The frozen `tools/proposition_canary_run.py`, canonical generator/verifier
prompts, worker configuration and source inputs were not changed by this
follow-up. Inference remains owned by the other session.

## Repairs

- Report and job metadata are parsed and hashed from the same bytes. Strict
  success requires matching terminal job/report statuses and explicit zero
  source-binding errors, independently of the aggregate error count.
- Complete artifact membership and file identities/signatures bracket full
  SHA-256 validation. A second full output hash pass detects changes to files
  already checked. An unstable observation cannot publish/resolve a successful
  selected attempt.
- Selection binds the report/job hashes actually validated. Concurrent changes
  before return/publication are rejected. Prior pointer/history remain intact
  on failed supersession; an orphan content-addressed history record is not an
  active selection.
- Postflight does not scan result trees for explicitly running/incomplete jobs.
  It returns pending. Contradictory terminal metadata returns invalid, and an
  unstable validator observation clears completion claims.
- Effective selection can locate selected call captures after an attempt is
  relocated across Windows/WSL paths. It extracts only the exact safe trailing
  `calls/<number>_<stage>` identity. All reads remain under the currently pinned
  job directory and require its file hashes and request/response/journal proof.
  Stored foreign/UNC path strings are never opened as read targets.
- Deep malformed JSON now follows the normal failure path rather than escaping
  the CLI as an uncaught recursion exception.

## Frozen Stage 1 Hash Note

`tools/proposition_attempts.py` was pinned by the separate Stage 1 report and is
changed by this follow-up. Do not edit that report, silently replace its old
hash, restart inference, or reissue already sent requests to hide this change.

Record the offline inspector/helper revision separately from the frozen model
execution inputs when returning Stage 3 evidence. The stricter helper validates
the same acceptance-v2 output format; it does not change the source/model
request contract. The frozen Stage 1 checker will correctly report the helper
hash change. That is a preparation-dependency change to review, not permission
to rerun the smoke or overwrite its reservation.

## Validation

Executed from the worldmodel root:

```text
python -B -m unittest discover -s tests
```

Result: 166 tests, 165 passed, one host-dependent symlink-creation skip, zero
failures. Mocked symlink rejection coverage passed. All inference calls and
worker dispatch in the tests use temporary fixtures/mocks.

First-round input verification:

```text
python -B runs/_extraction_scheduler/20260924/production_round1_audit_20261015/verify_repair_input_integrity.py
```

Result: 2,706 inventoried inputs; 2,703 byte-identical; only the three previously
documented runner files differ; zero unexpected changes. The original audit
inventory is retained unchanged.

## Limits

Stability checks establish a bounded local observation, not an atomic filesystem
snapshot or proof against an adversarial writer, NFS/SMB behavior, or power loss.
No live semantic quality result is implied.

Full reverify relocation remains fail-closed when its embedded generator path
no longer resolves to the explicitly pinned generator. No arbitrary drive/path
alias is guessed. Cross-platform capture handling was tested with foreign-path
fixtures on Windows; native POSIX execution was not verified in this follow-up.

Only the inference-owning session controls scheduling. Return its exact sealed
output directory for read-only postflight. Do not scan or parse in-flight raw
model output as a completed verdict.
