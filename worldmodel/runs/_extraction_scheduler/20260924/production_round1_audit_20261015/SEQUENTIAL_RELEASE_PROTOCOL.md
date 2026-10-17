# Sequential Release Protocol V1

Paths in this document are relative to the worldmodel root.

## Scope And Status

`tools/literal_sequential_release.py` is a small pure in-memory reducer, not a
network runner, database, authorization service, or dispatch integration. It
addresses the `lastfivecase` / `allsentbeforenormalization` failure mode only if
the inference owner adopts this sequence **at run time, before the next
multi-case live experiment**. A post-hoc journal cannot undo send-ahead or
establish true chronology. Nothing is integrated into the current Qwen runner.
This implementation supplies no new authorization or budget.

No API, health, models, real dispatch, process controls, current runner, prompt,
source, or attempt changes are involved. No model-card semantics are inferred;
no source, request payload, raw content, or normalized candidate payload is
stored by the reducer. All work remains pending8001. Here `accepted` means only
that a caller-supplied offline normalization receipt passed protocol checks,
not semantic acceptance, independent verification, promotion, or batch approval.

## API And Pins

Public operations:

```python
state = start(plan, plan_sha256=trusted_plan_hash,
              authorization_sha256=trusted_authorization_hash)
state, token = reserve_one_request(state, exact_request_body_bytes)
state = record_saved_response(state, envelope)
state = record_validation(state, receipt, receipt_data)
state = record_call_failure(state, "error")  # or "uncertain"; terminal
state = replay(persisted_canonical_bytes,
               expected_plan_sha256=trusted_plan_hash,
               expected_authorization_sha256=trusted_authorization_hash)
```

`State` and `ReleaseToken` are frozen. `state.canonical_state` is immutable
canonical JSON bytes; `state.document()` returns a detached inspection copy.
`canonical_bytes(value)` and `sha256_bytes(bytes)` are the hash utilities.
Canonical JSON is UTF-8, sorted keys, compact separators, `ensure_ascii=False`,
no trailing newline, floats, nonfinite values, or duplicate keys. Hashes are
lowercase full SHA256. Schemas are exact: missing/extra fields and boolean
substitutes for integer fields reject. No compatibility or schema repair exists.

The trusted pinned plan has exactly:

```text
schema_version: integer 1
package_manifest_sha256: SHA256 of the exact package manifest bytes
authorization_sha256: externally trusted authorization-document SHA256
max_requests: integer 1..5
one_per_case: true
retry_allowed: false
cases: ordered list of 1..max_requests records, each exactly:
    ordinal: consecutive integer starting at 1
    case_id: unique nonblank string
    request_id: unique nonblank string
    request_body_sha256: unique SHA256 of exact transport body bytes
```

The plan pin is SHA256 of `canonical_bytes(plan)`. Trusted external plan and
authorization pins must not be discovered from the journal under inspection.
The owner must verify the actual authorization and package, derive this plan
from the pinned package's ordered case/request records, and check their exact
correspondence before calling `start`. The reducer checks supplied pins and
body bytes, not package files, approval documents, expiry, or budget ledgers.
Re-pinning a changed plan is not authorization. Existing preparation and strict
offline normalization contracts remain unchanged.

## Required Owner Sequence

1. Take exclusive ownership of this authorization/journal. Read the authoritative
   latest durable state, validate it against externally trusted pins, and reject
   stale state. There must be a single writer or an equivalent durable atomic
   compare-and-swap on the chain head. Do not fork an earlier state or create a
   second journal under the same authorization.
2. Call `reserve_one_request` with the next case's exact body bytes. It returns
   only the current case/request binding and a reservation-event hash, never a
   batch or a request payload. The returned state is already
   `dispatched_uncertain` before the owner sends anything.
3. **Durably commit that reservation before transport.** The caller owns the
   append-only journal and authoritative state publication. Use appropriate
   write/flush/fsync and atomic commit semantics for the filesystem/storage,
   including directory synchronization where needed. Persist full events and
   enough state to replay; do not expose a send opportunity before successful
   commit. If commit/acknowledgment is uncertain, do not send.
4. Consume the token once in this live owner invocation, then send only that
   pinned body through the separately authorized transport. The token is a
   one-use bookkeeping convention, **not cryptographic authorization**, a
   transport capability, or enforceable exactly-once network delivery. Do not
   recover a token from a journal and use it to send again.
5. Save the exact raw response and its envelope durably, verify their pins, and
   call `record_saved_response`. Durably commit the returned state. The reducer
   only records trusted caller metadata; it does not read a file or prove that a
   save or network call happened. A successful envelope still leaves
   `pending_validation`; no next reservation is allowed.
6. Run the existing strict offline envelope checks and literal normalization
   for this case/request/raw/package, without semantic fabrication or repair.
   Save the real result and the bound machine-validation receipt durably. The
   owner needs an explicit adapter to produce the receipt schema below; this
   module neither invokes nor replaces the normalizer. Record the receipt and
   durably commit the resulting state **before** reserving the next case.
7. Continue only after a successful receipt. Rejected validation, an error
   envelope, or `record_call_failure(..., "error"/"uncertain")` is terminal.
   Remaining cases stay unattempted. After the final successful receipt the
   state is `complete`, with no further release.

On exceptions, malformed receipts, persistence failures, or ambiguous transport,
stop the owner. Validation exceptions do not mutate the input state or unlock
anything; record a terminal failure when possible. A crash after reservation
but before sending has the same conservative uncertainty as a crash after send.
Replay preserves `dispatched_uncertain`, or `pending_validation` if a response
was recorded, and returns **no token**. Neither permits releasing/resending the
current request. There is no automatic reset, retry, or resume operation. A
retry requires external human investigation and fresh explicit authorization;
do not obtain it by recreating the old plan, truncating the journal, or resetting
state. Replay is for checking/reconstruction, not a recovery-send instruction.

These are owner obligations, not guarantees supplied by a pure function. An
old immutable `ready` state can be reused to derive the same reservation; only
authoritative durable single-writer ownership prevents that fork. Reusing a
token or bypassing this reducer cannot be prevented by an in-memory library.

## Response And Validation

`record_saved_response` requires exactly:

```text
ordinal, case_id, request_id, request_body_sha256, package_manifest_sha256
raw_response_sha256: hash of exact saved raw envelope bytes
response_ref: nonblank caller-owned saved-envelope reference
http_status: integer 100..599
model: nonblank string, or null for an error envelope
finish_reason: nonblank string, or null for an error envelope
response_complete: boolean
```

All case/request/package fields must match the active reservation. Reused raw
hashes or response references reject, even across different cases. Only HTTP
200, completeness true, a non-null model and finish `stop` reach
`pending_validation`; other well-formed envelopes terminally stop. The model
string is recorded metadata, not model identity proof. Exact model, choice,
content, source identity and normalization checks remain the offline validator's
responsibility. Malformed or cross-case attachments raise and cannot advance.

`record_validation(state, receipt, receipt_data)` uses exactly this receipt:

```text
case_id
request_body_sha256
raw_response_sha256
package_manifest_sha256
normalization_receipt_sha256
valid: boolean
```

`normalization_receipt_sha256` must equal SHA256 of the entire canonical
`receipt_data` document. That document has exactly:

```text
schema_version: integer 1
ordinal, case_id, request_id, request_body_sha256
raw_response_sha256, package_manifest_sha256, authorization_sha256
response_event_sha256: hash of the immediately preceding saved-response event
normalization_result_sha256: hash of the caller's saved offline result bytes
normalization_success: boolean
verdict: "accepted" or "rejected"
```

Every identity, hash and sequence reference is bound to the active case and
recorded response. `valid` must equal `normalization_success` and agree with
`verdict`. Only true/true/accepted releases the next case. False/false/rejected
terminally stops. Reused receipts, duplicate attachment, reordered responses,
cross-case data, wrong pins, unsupported schemas and inconsistent verdicts
reject. A bare caller boolean is insufficient, but a caller can still fabricate
an entire self-consistent receipt and its hash. There is no signature trust
root, semantic proof, receipt file verification, or claim that actual strict
normalization occurred. Trusted receipt provenance remains the owner's duty.

## Chain And Replay

The version-1 state contains exactly `schema_version`, `plan`, `plan_sha256`,
`authorization_sha256`, `journal`, and reducer-computed `snapshot`. Each event
contains exactly `schema_version`, one-based `sequence`, `supersedes` (previous
event hash, null at genesis), `plan_sha256`, `authorization_sha256`,
`package_manifest_sha256`, `kind`, `data`, and `event_sha256`. The event hash is
SHA256 of the canonical event with only `event_sha256` omitted. There is no
wall-clock timestamp claim. Events bind exactly the supplied IDs, not inferred
aliases. Reservation binds the request; response supersedes reservation;
validation includes the response-event hash and raw/request pins; the next
reservation supersedes successful validation. Failure observations are also
chained and terminal.

`replay` reconstructs from the pinned plan by running the same reducer for
every event, compares each complete recomputed event, and finally compares the
entire recomputed state to persisted canonical bytes. Duplicate, missing,
out-of-order, tampered, or illegally rehashed event sequences and forged
snapshots fail. Normal operations also check the input state's internal replay
consistency. Those internal checks do not replace the owner's external pins.

A valid journal does not prove durability, remote execution, semantic validity,
or true temporal ordering. A dishonest caller can build a wholly consistent
post-hoc chain, or present a valid older prefix without the authoritative head.
Hash chaining is consistency checking, not external anchoring or anti-rollback.
The owner must adopt the gate before transport, retain the authoritative latest
head, and preserve real saved evidence. Historical all-sent-before-normalization
attempts must not be relabeled as sequentially dispatched by fabricating order.

## Offline Verification

`tests/test_literal_sequential_release.py` uses only in-memory synthetic plans,
receipts, and fake transport calls. Regression coverage includes first-case
failure (one fake call), third-case failure (three calls; two later cases
unattempted), transport uncertainty, all-five success with validation saved
before each next fake call, interruption on both sides of response recording,
pending-validation blocking, duplicate invocation against current/replayed
state, immutable state/events, strict schemas, pins, identity and reference
reuse, chain tampering, replay-computed snapshots, illegal reordering even with
recomputed hashes, and the explicit limits of fabricated post-hoc journals.
The tests do not establish actual normalization semantics or durable I/O.

Run from the workspace root:

```text
python -B -m unittest discover -s tests -p test_literal_sequential_release.py -v
```

Verified on 2026-10-17, all passed:

- Sequential release: 29 tests.
- Existing bound-literal experiment: 17 tests.
- Existing generic literal experiment: 24 tests.
- Total targeted offline checks: 70 tests. The full repository suite was not run.

No live model, API, health, service dispatch, or service/process controls were
used. Only the reducer, its synthetic tests, and this protocol document were
added; current production inference adoption remains an owner action, not a
change made by this implementation.
