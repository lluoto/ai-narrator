# Offline Work During Qwen Queue Wait

## Completed Without Inference

No model health/completion requests, service startup/restart, production
dispatch, or process control were performed. Existing production sources,
attempts, canonical prompts and STATE remain unchanged.

### Verifier Follow-Up Inventory

Latest diagnostic-only version:

```text
runs/_extraction_scheduler/20260924/verifier_followup_inventory_v2/
manifest SHA256: 71dc3036babc023cf999c42d1287ea912dde4eb49c121118ec58f0fb34db51c9
```

```text
457 failed attempt rows -> 457 unique candidate groups
378 original windows / 88 works
457 ready for verifier preparation
0 generator-repair candidates in this queue
0 deferred source/integrity candidates in this sealed scope
22 candidates have usable historical counterpart observations
```

The 22 counterparts comprise 14 historical entailed and eight insufficient
results. They remain advisory: no original/reverify precedence or effective
verdict is selected. No rerun is mandatory. Conditional future verification
scope is 0-457 card calls, not a request authorization.

Of these candidates, 292 use exact approved source-identity projection receipts;
108 have rejected siblings. Rejected siblings do not erase a sound selected
card, and the selected card does not certify the whole generation snapshot.
Historical raw-capture/provenance limits remain explicit.

Actual request packaging must use a binding-aware verifier preparation path
where needed; the generic card compiler does not silently inherit approvals.
Do not rewrite B001 records, substitute deduplicated source hashes in old jobs,
or claim this metadata inventory is an accepted verifier result.

### Sequential Release Protocol

```text
tools/literal_sequential_release.py
runs/_extraction_scheduler/20260924/production_round1_audit_20261015/SEQUENTIAL_RELEASE_PROTOCOL.md
```

The transport-free reducer releases only the current case. It cannot release a
later case until response binding and a successful bound normalization receipt
exist. Rejection/error stops the sequence. Uncertain dispatch cannot auto-retry.

Mock regressions demonstrate one call after first-case failure, three calls
after third-case failure, and validation-before-next ordering on full success.
The inference owner must adopt the protocol at execution time. It does not
retroactively repair the disclosed five-case send-ahead deviation. Persistence,
exclusive caller ownership and correct transport/capture still belong to the
caller; internal hashes do not prove real chronology or provider execution.

## Test Isolation

The monolithic `unittest discover` run reported two failures because historical
inventory tests assert no canonical runner module exists in global sys.modules,
while unrelated pure-contract suites had already imported it. Both historical
test modules pass alone. Their bytes are pinned by sealed audit manifests.

Rather than edit those pinned tests or weaken the assertion, use the serial
module-isolation entry point:

```text
python -B tools/run_offline_unittests.py
```

It launches unit-test modules only, preserves full child output, makes no retry,
and treats child errors, timeouts and missing/truncated summaries as failures.
It is not a model dispatcher or a production runner.

Actual result:

```text
Python 3.11.7
23/23 modules passed
647 tests: 645 passed, 2 symlink-privilege skips, 0 failures, 0 errors
```

Full retained transcript:

```text
C:\Users\lluoto\AppData\Local\Temp\opencode\worldmodel-offline-module-tests-20261016.log
```

The earlier monolithic two-failure result is retained as test-isolation evidence,
not presented as all-green. Module isolation is the verified suite boundary.

## Still Pending

- No new Qwen budget or bulk authorization is supplied by this work.
- Five-case strict-JSON formatting and runtime sequence adoption need a new
  controlled experiment; do not strip the rejected Markdown fence.
- 457 historical verifier repairs still need scoped request packages and
  separately scheduled 8001 execution when available.
- 713 original/reverify status differences remain unresolved; bulk semantic
  adjudication stays assigned to Luna.
- All normalized candidates remain pending independent verification; no
  semantic certification, human-gold, publication or runtime effect is implied.
