"""Transport-free sequential gate. Caller owns authority, persistence and receipts.

Hashes establish internal consistency, not durable writes, dispatch or semantics.
There is deliberately no runner import, I/O, retry, reset or recovery-send API.
"""
from dataclasses import dataclass
import hashlib
import json
import re


def require(condition, code):
    if not condition:
        raise ValueError(code)


def shape(value, keys):
    require(type(value) is dict and set(value) == set(keys.split()), "invalid_schema")


def text(value):
    require(type(value) is str and bool(value.strip()), "invalid_text")


def sha(value):
    require(type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value) is not None,
            "invalid_sha256")


def canonical_bytes(value):
    """Protocol JSON: UTF-8, sorted keys, compact separators, no floats."""
    if type(value) is dict:
        for key, item in value.items():
            require(type(key) is str, "invalid_json_key")
            canonical_bytes(item)
    elif type(value) is list:
        for item in value:
            canonical_bytes(item)
    else:
        require(value is None or type(value) in (str, int, bool), "invalid_json_value")
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def sha256_bytes(value):
    require(type(value) is bytes, "expected_bytes")
    return hashlib.sha256(value).hexdigest()


def _decode(value):
    require(type(value) is bytes, "expected_bytes")

    def pairs(items):
        result = {}
        for key, item in items:
            require(key not in result, "duplicate_json_key")
            result[key] = item
        return result

    result = json.loads(value, object_pairs_hook=pairs)
    require(canonical_bytes(result) == value, "noncanonical_json")
    return result


@dataclass(frozen=True)
class State:
    canonical_state: bytes

    def document(self):
        """Detached JSON copy; mutations cannot change this state."""
        return _decode(self.canonical_state)


@dataclass(frozen=True)
class ReleaseToken:
    """One-use caller bookkeeping only, NOT cryptographic authorization."""
    case_id: str
    request_id: str
    ordinal: int
    request_body_sha256: str
    reservation_event_sha256: str


def _plan(plan, plan_sha256, authorization_sha256):
    shape(plan, "schema_version package_manifest_sha256 authorization_sha256 "
          "max_requests one_per_case retry_allowed cases")
    require(type(plan["schema_version"]) is int and plan["schema_version"] == 1,
            "unsupported_version")
    for value in (plan_sha256, authorization_sha256, plan["package_manifest_sha256"],
                  plan["authorization_sha256"]):
        sha(value)
    require(sha256_bytes(canonical_bytes(plan)) == plan_sha256, "plan_pin_mismatch")
    require(plan["authorization_sha256"] == authorization_sha256, "authorization_pin_mismatch")
    require(type(plan["max_requests"]) is int and 1 <= plan["max_requests"] <= 5
            and plan["one_per_case"] is True and plan["retry_allowed"] is False,
            "invalid_limits")
    require(type(plan["cases"]) is list and 1 <= len(plan["cases"]) <= plan["max_requests"],
            "invalid_case_count")
    seen = {key: set() for key in ("case_id", "request_id", "request_body_sha256")}
    for ordinal, case in enumerate(plan["cases"], 1):
        shape(case, "ordinal case_id request_id request_body_sha256")
        require(type(case["ordinal"]) is int and case["ordinal"] == ordinal, "case_ordinal")
        text(case["case_id"])
        text(case["request_id"])
        sha(case["request_body_sha256"])
        for key, values in seen.items():
            require(case[key] not in values, "duplicate_" + key)
            values.add(case[key])


def start(plan, *, plan_sha256, authorization_sha256):
    """Pins must come from the trusted owner, not from a journal being checked."""
    _plan(plan, plan_sha256, authorization_sha256)
    return State(canonical_bytes({
        "schema_version": 1, "plan": plan, "plan_sha256": plan_sha256,
        "authorization_sha256": authorization_sha256, "journal": [],
        "snapshot": {"status": "ready", "reserved_count": 0, "accepted_count": 0,
                     "stop_reason": None, "responses": [], "validation_receipt_sha256s": []},
    }))


def _binding(plan, case):
    return {**case, "package_manifest_sha256": plan["package_manifest_sha256"]}


def _apply(doc, kind, data, previous_hash):
    """Shared live/replay reducer; modifies only a private decoded document."""
    plan, snap = doc["plan"], doc["snapshot"]
    status = snap["status"]
    if kind == "reserve_one_request":
        require(status == "ready", "release_blocked")
        expected = _binding(plan, plan["cases"][snap["reserved_count"]])
        require(canonical_bytes(data) == canonical_bytes(expected), "reservation_binding")
        snap["reserved_count"] += 1
        snap["status"] = "dispatched_uncertain"
        return
    require(status in ("dispatched_uncertain", "pending_validation"), "terminal_or_no_current")
    case = plan["cases"][snap["reserved_count"] - 1]
    binding = _binding(plan, case)
    if kind == "record_call_failure":
        shape(data, "outcome")
        require(data["outcome"] in ("error", "uncertain"), "invalid_failure")
        snap.update(status="stopped", stop_reason=data["outcome"])
    elif kind == "record_saved_response":
        require(status == "dispatched_uncertain", "response_out_of_order")
        shape(data, "ordinal case_id request_id request_body_sha256 package_manifest_sha256 "
              "raw_response_sha256 response_ref http_status model finish_reason response_complete")
        require(type(data["ordinal"]) is int, "case_ordinal")
        require(all(data[key] == value for key, value in binding.items()), "response_binding")
        sha(data["raw_response_sha256"])
        text(data["response_ref"])
        require(type(data["http_status"]) is int and 100 <= data["http_status"] <= 599,
                "invalid_http_status")
        require(type(data["response_complete"]) is bool, "invalid_completeness")
        for key in ("model", "finish_reason"):
            if data[key] is not None:
                text(data[key])
        for prior in snap["responses"]:
            require(data["response_ref"] != prior["response_ref"], "response_ref_reuse")
            require(data["raw_response_sha256"] != prior["raw_response_sha256"], "raw_hash_reuse")
        snap["responses"].append(data)
        if (data["http_status"] == 200 and data["response_complete"] is True
                and data["model"] is not None and data["finish_reason"] == "stop"):
            snap["status"] = "pending_validation"
        else:
            snap.update(status="stopped", stop_reason="response_envelope_error")
    elif kind == "record_validation":
        require(status == "pending_validation", "validation_out_of_order")
        shape(data, "receipt receipt_data")
        receipt, result = data["receipt"], data["receipt_data"]
        shape(receipt, "case_id request_body_sha256 raw_response_sha256 package_manifest_sha256 "
              "normalization_receipt_sha256 valid")
        shape(result, "schema_version ordinal case_id request_id request_body_sha256 "
              "raw_response_sha256 package_manifest_sha256 authorization_sha256 "
              "response_event_sha256 normalization_result_sha256 normalization_success verdict")
        require(type(result["schema_version"]) is int and result["schema_version"] == 1,
                "unsupported_version")
        require(type(result["ordinal"]) is int, "case_ordinal")
        require(all(result[key] == value for key, value in binding.items()), "validation_binding")
        require(result["authorization_sha256"] == doc["authorization_sha256"]
                and result["response_event_sha256"] == previous_hash, "validation_event_binding")
        sha(result["normalization_result_sha256"])
        require(type(receipt["valid"]) is bool and type(result["normalization_success"]) is bool,
                "invalid_verdict")
        require(result["normalization_success"] == receipt["valid"]
                and result["verdict"] == ("accepted" if receipt["valid"] else "rejected"),
                "inconsistent_verdict")
        raw_hash = snap["responses"][-1]["raw_response_sha256"]
        require(result["raw_response_sha256"] == raw_hash, "validation_raw_binding")
        for key in ("case_id", "request_body_sha256", "raw_response_sha256", "package_manifest_sha256"):
            require(receipt[key] == result[key], "receipt_binding")
        sha(receipt["normalization_receipt_sha256"])
        require(sha256_bytes(canonical_bytes(result)) == receipt["normalization_receipt_sha256"],
                "receipt_hash_mismatch")
        require(receipt["normalization_receipt_sha256"] not in snap["validation_receipt_sha256s"],
                "receipt_reuse")
        snap["validation_receipt_sha256s"].append(receipt["normalization_receipt_sha256"])
        if receipt["valid"]:
            snap["accepted_count"] += 1
            snap["status"] = ("complete" if snap["accepted_count"] == len(plan["cases"]) else "ready")
        else:
            snap.update(status="stopped", stop_reason="validation_rejected")
    else:
        raise ValueError("unknown_event")


def _advance(doc, kind, data):
    previous_hash = doc["journal"][-1]["event_sha256"] if doc["journal"] else None
    event = {"schema_version": 1, "sequence": len(doc["journal"]) + 1,
             "supersedes": previous_hash, "plan_sha256": doc["plan_sha256"],
             "authorization_sha256": doc["authorization_sha256"],
             "package_manifest_sha256": doc["plan"]["package_manifest_sha256"],
             "kind": kind, "data": data}
    event["event_sha256"] = sha256_bytes(canonical_bytes(event))
    _apply(doc, kind, data, previous_hash)
    doc["journal"].append(event)
    return State(canonical_bytes(doc))


def replay(canonical_state, *, expected_plan_sha256, expected_authorization_sha256):
    """Recompute every event AND snapshot against external trusted pins.

    Returns no release token. A valid journal is not proof of real chronology.
    """
    doc = _decode(canonical_state)
    shape(doc, "schema_version plan plan_sha256 authorization_sha256 journal snapshot")
    require(type(doc["schema_version"]) is int and doc["schema_version"] == 1, "unsupported_version")
    require(doc["plan_sha256"] == expected_plan_sha256, "plan_pin_mismatch")
    require(doc["authorization_sha256"] == expected_authorization_sha256, "authorization_pin_mismatch")
    state = start(doc["plan"], plan_sha256=expected_plan_sha256,
                  authorization_sha256=expected_authorization_sha256)
    require(type(doc["journal"]) is list, "invalid_journal")
    for event in doc["journal"]:
        shape(event, "schema_version sequence supersedes plan_sha256 authorization_sha256 "
              "package_manifest_sha256 kind data event_sha256")
        require(type(event["schema_version"]) is int and type(event["sequence"]) is int,
                "invalid_event_numbers")
        computed = _advance(state.document(), event["kind"], event["data"])
        require(canonical_bytes(computed.document()["journal"][-1]) == canonical_bytes(event),
                "event_chain_mismatch")
        state = computed
    require(state.canonical_state == canonical_state, "recomputed_state_mismatch")
    return state


def _checked(state):
    require(type(state) is State, "invalid_state")
    doc = state.document()
    shape(doc, "schema_version plan plan_sha256 authorization_sha256 journal snapshot")
    replay(state.canonical_state, expected_plan_sha256=doc["plan_sha256"],
           expected_authorization_sha256=doc["authorization_sha256"])
    return doc


def reserve_one_request(state, request_body):
    """Hash exact bytes; return only the next binding, never a body or batch.

    Owner MUST durably commit the returned state before using the token once.
    """
    doc = _checked(state)
    require(doc["snapshot"]["status"] == "ready", "release_blocked")
    case = doc["plan"]["cases"][doc["snapshot"]["reserved_count"]]
    require(sha256_bytes(request_body) == case["request_body_sha256"], "request_body_pin_mismatch")
    updated = _advance(doc, "reserve_one_request", _binding(doc["plan"], case))
    token = ReleaseToken(**case, reservation_event_sha256=updated.document()["journal"][-1]["event_sha256"])
    return updated, token


def record_saved_response(state, envelope):
    """Trusted caller reports a saved raw envelope; this function does not read it."""
    return _advance(_checked(state), "record_saved_response", envelope)


def record_validation(state, receipt, receipt_data):
    """Check a complete receipt's shape, pins and canonical hash, not semantics."""
    return _advance(_checked(state), "record_validation", {"receipt": receipt, "receipt_data": receipt_data})


def record_call_failure(state, outcome):
    """Terminal error/uncertain observation. No reset, retry or resume exists."""
    return _advance(_checked(state), "record_call_failure", {"outcome": outcome})
