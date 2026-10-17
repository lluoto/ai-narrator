"""In-memory synthetic receipts/transports only; no actual model or normalizer."""
import ast
import copy
from dataclasses import FrozenInstanceError
import inspect
import unittest
from unittest import mock

from tools import literal_sequential_release as T


def digest(value):
    return T.sha256_bytes(T.canonical_bytes(value))


class SequentialReleaseTests(unittest.TestCase):
    def setUp(self):
        self.bodies = [T.canonical_bytes({"synthetic_request": number}) for number in range(1, 6)]
        self.auth = digest("synthetic_authorization")
        self.plan = {"schema_version": 1, "package_manifest_sha256": digest("synthetic_package"),
                     "authorization_sha256": self.auth, "max_requests": 5,
                     "one_per_case": True, "retry_allowed": False,
                     "cases": [{"ordinal": number, "case_id": f"case-{number}",
                                "request_id": f"request-{number}",
                                "request_body_sha256": T.sha256_bytes(body)}
                               for number, body in enumerate(self.bodies, 1)]}
        self.pin = digest(self.plan)
        self.state = self.start()

    def start(self, plan=None):
        plan = self.plan if plan is None else plan
        return T.start(plan, plan_sha256=digest(plan), authorization_sha256=self.auth)

    def replay(self, state):
        return T.replay(state.canonical_state, expected_plan_sha256=self.pin,
                        expected_authorization_sha256=self.auth)

    def reserve(self, state=None):
        state = self.state if state is None else state
        index = state.document()["snapshot"]["reserved_count"]
        return T.reserve_one_request(state, self.bodies[index])

    def envelope(self, state):
        doc = state.document()
        case = doc["plan"]["cases"][doc["snapshot"]["reserved_count"] - 1]
        return {**case, "package_manifest_sha256": self.plan["package_manifest_sha256"],
                "raw_response_sha256": digest({"synthetic_raw": case["ordinal"]}),
                "response_ref": f"synthetic-saved-envelope-{case['ordinal']}",
                "http_status": 200, "model": "synthetic-only-model", "finish_reason": "stop",
                "response_complete": True}

    def receipts(self, state, valid=True):
        doc = state.document()
        response = doc["snapshot"]["responses"][-1]
        result = {key: response[key] for key in ("ordinal", "case_id", "request_id",
                  "request_body_sha256", "raw_response_sha256", "package_manifest_sha256")}
        result.update(schema_version=1, authorization_sha256=self.auth,
                      response_event_sha256=doc["journal"][-1]["event_sha256"],
                      normalization_result_sha256=digest({"synthetic_result": response["ordinal"]}),
                      normalization_success=valid, verdict="accepted" if valid else "rejected")
        receipt = {key: result[key] for key in ("case_id", "request_body_sha256",
                   "raw_response_sha256", "package_manifest_sha256")}
        receipt.update(normalization_receipt_sha256=digest(result), valid=valid)
        return receipt, result

    def responded(self, state=None):
        reserved, _ = self.reserve(state)
        return T.record_saved_response(reserved, self.envelope(reserved))

    def accepted(self, state=None):
        state = self.responded(state)
        return T.record_validation(state, *self.receipts(state))

    def assert_blocked(self, state):
        for body in self.bodies:
            with self.assertRaisesRegex(ValueError, "release_blocked"):
                T.reserve_one_request(state, body)

    def test_initial_state_and_next_only_token(self):
        self.assertEqual(self.state.document()["snapshot"]["status"], "ready")
        state, token = self.reserve()
        self.assertEqual(token.case_id, "case-1")
        self.assertEqual(token.request_id, "request-1")
        self.assertEqual(token.ordinal, 1)
        self.assertEqual(token.request_body_sha256, T.sha256_bytes(self.bodies[0]))
        self.assertEqual(token.reservation_event_sha256, state.document()["journal"][0]["event_sha256"])
        self.assertEqual(set(vars(token)), {"case_id", "request_id", "ordinal",
                         "request_body_sha256", "reservation_event_sha256"})
        self.assertEqual(state.document()["snapshot"]["status"], "dispatched_uncertain")
        self.assertEqual(self.state.document()["snapshot"]["reserved_count"], 0)
        self.assert_blocked(state)

    def test_plan_limits_schema_ids_ordinals_and_hashes(self):
        mutations = [lambda p: p.update(schema_version=True), lambda p: p.update(schema_version=2),
                     lambda p: p.update(max_requests=6), lambda p: p.update(max_requests=0),
                     lambda p: p.update(max_requests=True), lambda p: p.update(max_requests=4),
                     lambda p: p.update(one_per_case=1), lambda p: p.update(retry_allowed=True),
                     lambda p: p.update(cases=[]), lambda p: p.update(extra="payload"),
                     lambda p: p["cases"][0].update(ordinal=True),
                     lambda p: p["cases"][0].update(ordinal=2),
                     lambda p: p["cases"].reverse(),
                     lambda p: p["cases"][1].update(case_id="case-1"),
                     lambda p: p["cases"][1].update(request_id="request-1"),
                     lambda p: p["cases"][1].update(request_body_sha256=p["cases"][0]["request_body_sha256"]),
                     lambda p: p["cases"][0].update(case_id=" "),
                     lambda p: p["cases"][0].update(request_body_sha256="A" * 64),
                     lambda p: p["cases"][0].update(request_body_sha256="bad"),
                     lambda p: p["cases"][0].update(body="must_not_store_payload")]
        for mutation in mutations:
            with self.subTest(mutation=mutations.index(mutation)):
                plan = copy.deepcopy(self.plan)
                mutation(plan)
                with self.assertRaises(ValueError):
                    self.start(plan)

    def test_explicit_external_plan_and_authorization_pins(self):
        with self.assertRaisesRegex(ValueError, "plan_pin_mismatch"):
            T.start(self.plan, plan_sha256=digest("other"), authorization_sha256=self.auth)
        with self.assertRaisesRegex(ValueError, "authorization_pin_mismatch"):
            T.start(self.plan, plan_sha256=self.pin, authorization_sha256=digest("other"))
        for kwargs in ({"expected_plan_sha256": digest("other"), "expected_authorization_sha256": self.auth},
                       {"expected_plan_sha256": self.pin, "expected_authorization_sha256": digest("other")}):
            with self.assertRaises(ValueError):
                T.replay(self.state.canonical_state, **kwargs)

    def test_one_through_five_case_plans(self):
        for count in range(1, 6):
            with self.subTest(count=count):
                plan = copy.deepcopy(self.plan)
                plan.update(cases=plan["cases"][:count], max_requests=count)
                state = self.start(plan)
                for _ in range(count):
                    state = self.accepted(state)
                self.assertEqual(state.document()["snapshot"]["status"], "complete")
                self.assertEqual(state.document()["snapshot"]["reserved_count"], count)
                self.assert_blocked(state)

    def test_exact_request_bytes_required_and_not_retained(self):
        for body in (self.bodies[1], self.bodies[0] + b"\n", b"tampered"):
            with self.assertRaisesRegex(ValueError, "request_body_pin_mismatch"):
                T.reserve_one_request(self.state, body)
        with self.assertRaisesRegex(ValueError, "expected_bytes"):
            T.reserve_one_request(self.state, self.bodies[0].decode())
        state, _ = self.reserve()
        self.assertNotIn(b"synthetic_request", state.canonical_state)

    def test_pending_validation_blocks_all_next_requests(self):
        state = self.responded()
        self.assertEqual(state.document()["snapshot"]["status"], "pending_validation")
        self.assert_blocked(state)
        self.assert_blocked(self.replay(state))
        state = T.record_validation(state, *self.receipts(state))
        next_state, token = self.reserve(state)
        self.assertEqual(token.case_id, "case-2")
        self.assertEqual(next_state.document()["snapshot"]["reserved_count"], 2)

    def test_interruptions_before_and_after_response_never_return_recovery_token(self):
        reserved, _ = self.reserve()
        for state in (reserved, T.record_saved_response(reserved, self.envelope(reserved))):
            with self.subTest(status=state.document()["snapshot"]["status"]):
                reconstructed = self.replay(state)
                self.assertIs(type(reconstructed), T.State)
                self.assertEqual(reconstructed, state)
                self.assert_blocked(reconstructed)

    def test_duplicate_invocation_and_replay_cannot_reserve_current_again(self):
        state, token = self.reserve()
        self.assert_blocked(state)
        self.assert_blocked(self.replay(state))
        with self.assertRaises(FrozenInstanceError):
            token.case_id = "case-2"

    def test_reversed_and_cross_case_response_bindings_reject(self):
        state, _ = self.reserve()
        envelope = self.envelope(state)
        changes = {"case_id": "case-2", "request_id": "request-2", "ordinal": 2,
                   "request_body_sha256": digest("wrong"), "package_manifest_sha256": digest("wrong")}
        for key, value in changes.items():
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "response_binding"):
                T.record_saved_response(state, {**envelope, key: value})
        state = self.accepted()
        reserved, _ = self.reserve(state)
        with self.assertRaisesRegex(ValueError, "response_binding"):
            T.record_saved_response(reserved, envelope)

    def test_duplicate_response_and_validation_attach_reject(self):
        state, _ = self.reserve()
        envelope = self.envelope(state)
        responded = T.record_saved_response(state, envelope)
        with self.assertRaisesRegex(ValueError, "response_out_of_order"):
            T.record_saved_response(responded, envelope)
        receipt, result = self.receipts(responded)
        accepted = T.record_validation(responded, receipt, result)
        with self.assertRaisesRegex(ValueError, "terminal_or_no_current"):
            T.record_validation(accepted, receipt, result)
        reserved, _ = self.reserve(accepted)
        responded2 = T.record_saved_response(reserved, self.envelope(reserved))
        with self.assertRaisesRegex(ValueError, "validation_binding"):
            T.record_validation(responded2, receipt, result)

    def test_response_reference_and_raw_hash_reuse_reject(self):
        accepted = self.accepted()
        reserved, _ = self.reserve(accepted)
        response = self.envelope(reserved)
        prior = accepted.document()["snapshot"]["responses"][0]
        for key, code in (("response_ref", "response_ref_reuse"), ("raw_response_sha256", "raw_hash_reuse")):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, code):
                T.record_saved_response(reserved, {**response, key: prior[key]})

    def test_response_strict_schema(self):
        state, _ = self.reserve()
        response = self.envelope(state)
        for key, value in (("http_status", True), ("http_status", "200"), ("http_status", 600),
                           ("response_complete", 1), ("model", ""), ("finish_reason", []),
                           ("raw_response_sha256", "bad"), ("ordinal", True), ("response_ref", " ")):
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                T.record_saved_response(state, {**response, key: value})
        for changed in ({**response, "source_payload": "forbidden"},
                        {key: value for key, value in response.items() if key != "model"}):
            with self.assertRaisesRegex(ValueError, "invalid_schema"):
                T.record_saved_response(state, changed)

    def test_unsuccessful_envelopes_terminal_stop(self):
        reserved, _ = self.reserve()
        for key, value in (("http_status", 500), ("http_status", 201), ("response_complete", False),
                           ("finish_reason", "length"), ("finish_reason", None), ("model", None)):
            with self.subTest(key=key, value=value):
                state = T.record_saved_response(reserved, {**self.envelope(reserved), key: value})
                self.assertEqual(state.document()["snapshot"]["status"], "stopped")
                self.assert_blocked(state)
                self.assert_blocked(self.replay(state))
                with self.assertRaises(ValueError):
                    T.record_validation(state, {}, {})

    def test_error_and_uncertain_are_terminal_without_reset(self):
        reserved, _ = self.reserve()
        for current in (reserved, self.responded()):
            for outcome in ("error", "uncertain"):
                with self.subTest(outcome=outcome):
                    stopped = T.record_call_failure(current, outcome)
                    self.assertEqual(stopped.document()["snapshot"]["stop_reason"], outcome)
                    self.assert_blocked(self.replay(stopped))
                    with self.assertRaises(ValueError):
                        T.record_saved_response(stopped, self.envelope(current))
                    with self.assertRaises(ValueError):
                        T.record_call_failure(stopped, outcome)
        with self.assertRaises(ValueError):
            T.record_call_failure(reserved, "retry")
        with self.assertRaises(ValueError):
            T.record_call_failure(self.state, "error")

    def test_rejection_is_terminal_and_later_cases_unattempted(self):
        state = self.responded()
        state = T.record_validation(state, *self.receipts(state, False))
        self.assertEqual(state.document()["snapshot"]["stop_reason"], "validation_rejected")
        self.assertEqual(state.document()["snapshot"]["reserved_count"], 1)
        self.assertEqual(state.document()["snapshot"]["accepted_count"], 0)
        self.assert_blocked(self.replay(state))

    def test_validation_requires_response_first(self):
        reserved, _ = self.reserve()
        with self.assertRaisesRegex(ValueError, "validation_out_of_order"):
            T.record_validation(reserved, {}, {})
        with self.assertRaisesRegex(ValueError, "terminal_or_no_current"):
            T.record_saved_response(self.state, {})

    def test_validation_strict_schema_and_no_free_boolean(self):
        state = self.responded()
        receipt, result = self.receipts(state)
        for malformed in ({"valid": True}, {**receipt, "valid": 1}, {**receipt, "extra": True},
                          {key: value for key, value in receipt.items() if key != "normalization_receipt_sha256"}):
            with self.assertRaises(ValueError):
                T.record_validation(state, malformed, result)
        for key, value in (("normalization_success", 1), ("normalization_success", False),
                           ("verdict", "rejected"), ("schema_version", True), ("schema_version", 2),
                           ("ordinal", True), ("extra", "not allowed")):
            changed = {**result, key: value}
            with self.subTest(key=key), self.assertRaises(ValueError):
                T.record_validation(state, {**receipt, "normalization_receipt_sha256": digest(changed)}, changed)
        with self.assertRaisesRegex(ValueError, "receipt_hash_mismatch"):
            T.record_validation(state, {**receipt, "normalization_receipt_sha256": digest("fabricated")}, result)

    def test_validation_pins_all_identifiers_and_saved_response(self):
        state = self.responded()
        receipt, result = self.receipts(state)
        changes = {"case_id": "case-2", "request_id": "request-2", "ordinal": 2,
                   "request_body_sha256": digest("wrong"), "raw_response_sha256": digest("wrong"),
                   "package_manifest_sha256": digest("wrong"), "authorization_sha256": digest("wrong"),
                   "response_event_sha256": digest("wrong"), "normalization_result_sha256": "bad"}
        for key, value in changes.items():
            changed = {**result, key: value}
            changed_receipt = {**receipt, "normalization_receipt_sha256": digest(changed)}
            if key in changed_receipt:
                changed_receipt[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                T.record_validation(state, changed_receipt, changed)
        for key in ("case_id", "request_body_sha256", "raw_response_sha256", "package_manifest_sha256"):
            with self.subTest(receipt_key=key), self.assertRaisesRegex(ValueError, "receipt_binding"):
                T.record_validation(state, {**receipt, key: "wrong"}, result)

    def test_state_event_and_input_immutability(self):
        before = self.state.canonical_state
        reserved, _ = self.reserve()
        response = self.envelope(reserved)
        responded = T.record_saved_response(reserved, response)
        response["case_id"] = "mutated"
        receipt, result = self.receipts(responded)
        accepted = T.record_validation(responded, receipt, result)
        receipt["valid"] = False
        result["verdict"] = "rejected"
        detached = accepted.document()
        detached["journal"][0]["data"]["case_id"] = "mutated"
        self.plan["cases"][0]["case_id"] = "mutated"
        self.assertEqual(self.state.canonical_state, before)
        self.assertEqual(self.replay(accepted), accepted)
        with self.assertRaises(FrozenInstanceError):
            accepted.canonical_state = b"{}"

    def test_deterministic_chain_binds_exact_ids_and_supersedes(self):
        first, second = self.accepted(), self.accepted()
        self.assertEqual(first.canonical_state, second.canonical_state)
        previous = None
        for number, event in enumerate(first.document()["journal"], 1):
            self.assertEqual(event["sequence"], number)
            self.assertEqual(event["supersedes"], previous)
            self.assertEqual(event["authorization_sha256"], self.auth)
            self.assertEqual(event["package_manifest_sha256"], self.plan["package_manifest_sha256"])
            self.assertEqual(event["plan_sha256"], self.pin)
            unhashed = {key: value for key, value in event.items() if key != "event_sha256"}
            self.assertEqual(event["event_sha256"], digest(unhashed))
            previous = event["event_sha256"]
        self.assertEqual(first.document()["journal"][0]["data"]["request_id"], "request-1")

    def test_replay_rejects_tampered_event_hash_sequence_binding_and_snapshot(self):
        state = self.accepted()
        mutations = [lambda d: d["journal"][0].update(event_sha256=digest("wrong")),
                     lambda d: d["journal"][1].update(sequence=9),
                     lambda d: d["journal"][1].update(sequence=True),
                     lambda d: d["journal"][1].update(supersedes=None),
                     lambda d: d["journal"][1].update(authorization_sha256=digest("wrong")),
                     lambda d: d["journal"][1]["data"].update(request_id="wrong"),
                     lambda d: d["snapshot"].update(status="ready", accepted_count=5),
                     lambda d: d["snapshot"].update(extra=True),
                     lambda d: d["plan"]["cases"][0].update(case_id="wrong"),
                     lambda d: d.update(schema_version=True), lambda d: d.update(extra=True)]
        for number, mutation in enumerate(mutations):
            with self.subTest(mutation=number):
                doc = state.document()
                mutation(doc)
                changed = T.State(T.canonical_bytes(doc))
                with self.assertRaises(ValueError):
                    self.replay(changed)
                with self.assertRaises(ValueError):
                    T.reserve_one_request(changed, self.bodies[1])

    def test_replay_rejects_duplicate_reversed_missing_and_rehashed_illegal_order(self):
        state = self.accepted()
        original = state.document()["journal"]
        orders = [[original[0], original[0], *original[1:]], list(reversed(original)),
                  [original[0], original[2]], [original[0], original[2], original[1]]]
        for events in orders:
            for rehash in (False, True):
                with self.subTest(order=[e["kind"] for e in events], rehash=rehash):
                    doc = state.document()
                    doc["journal"] = copy.deepcopy(events)
                    if rehash:
                        previous = None
                        for number, event in enumerate(doc["journal"], 1):
                            event.update(sequence=number, supersedes=previous)
                            event.pop("event_sha256")
                            event["event_sha256"] = digest(event)
                            previous = event["event_sha256"]
                    with self.assertRaises(ValueError):
                        self.replay(T.State(T.canonical_bytes(doc)))

    def test_json_boundary_rejects_duplicate_keys_noncanonical_and_nonprotocol_values(self):
        for raw in (b'{"schema_version":1,"schema_version":1}',
                    self.state.canonical_state + b"\n", b'{"value":NaN}'):
            with self.assertRaises(ValueError):
                T.replay(raw, expected_plan_sha256=self.pin, expected_authorization_sha256=self.auth)
        for value in (float("nan"), 1.0, (1,), {1: "bad"}):
            with self.assertRaises(ValueError):
                T.canonical_bytes(value)
        for document in ({}, [], {"schema_version": 1}):
            with self.assertRaisesRegex(ValueError, "invalid_schema"):
                T.reserve_one_request(T.State(T.canonical_bytes(document)), self.bodies[0])

    def run_mock_owner(self, failing_case=None, transport_error=False):
        # This models caller ordering, NOT a durable journal or network service.
        state = self.state
        persisted = state.canonical_state
        trace, sent_ids = [], set()

        def fake_transport(token):
            self.assertEqual(persisted, state.canonical_state)
            self.assertEqual(state.document()["snapshot"]["status"], "dispatched_uncertain")
            self.assertNotIn(token.request_id, sent_ids)
            sent_ids.add(token.request_id)
            trace.append((token.ordinal, "transport"))
            if transport_error and token.ordinal == failing_case:
                raise RuntimeError("synthetic uncertain transport error")
            return self.envelope(state)

        transport = mock.Mock(side_effect=fake_transport)
        for number in range(1, 6):
            state, token = self.reserve(state)
            persisted = state.canonical_state
            trace.append((number, "reservation_saved"))
            try:
                envelope = transport(token)
            except RuntimeError:
                state = T.record_call_failure(state, "uncertain")
                persisted = state.canonical_state
                break
            state = T.record_saved_response(state, envelope)
            persisted = state.canonical_state
            trace.append((number, "response_saved"))
            state = T.record_validation(state, *self.receipts(state, number != failing_case))
            persisted = state.canonical_state
            trace.append((number, "validation_saved"))
            if state.document()["snapshot"]["status"] == "stopped":
                break
        self.assertEqual(persisted, state.canonical_state)
        return state, transport, trace

    def test_mock_first_validation_failure_calls_only_one_transport(self):
        state, transport, _ = self.run_mock_owner(failing_case=1)
        self.assertEqual(transport.call_count, 1)
        self.assertEqual(state.document()["snapshot"]["reserved_count"], 1)
        self.assertEqual(len(self.plan["cases"]) - state.document()["snapshot"]["reserved_count"], 4)
        self.assert_blocked(self.replay(state))

    def test_mock_third_validation_failure_calls_only_three_transports(self):
        state, transport, _ = self.run_mock_owner(failing_case=3)
        self.assertEqual(transport.call_count, 3)
        self.assertEqual(state.document()["snapshot"]["reserved_count"], 3)
        self.assertEqual(state.document()["snapshot"]["accepted_count"], 2)
        self.assert_blocked(state)

    def test_mock_transport_failure_never_sends_later_cases(self):
        for failing_case in (1, 3):
            with self.subTest(case=failing_case):
                state, transport, _ = self.run_mock_owner(failing_case, transport_error=True)
                self.assertEqual(transport.call_count, failing_case)
                self.assertEqual(state.document()["snapshot"]["stop_reason"], "uncertain")
                self.assert_blocked(self.replay(state))

    def test_mock_all_five_success_save_validation_before_next_transport(self):
        state, transport, trace = self.run_mock_owner()
        self.assertEqual(transport.call_count, 5)
        self.assertEqual(trace, [(number, stage) for number in range(1, 6)
                                for stage in ("reservation_saved", "transport", "response_saved", "validation_saved")])
        self.assertEqual(state.document()["snapshot"]["accepted_count"], 5)
        self.assertEqual(len(state.document()["journal"]), 15)
        self.assertEqual(self.replay(state), state)
        self.assert_blocked(state)

    def test_fabricated_consistent_journal_cannot_prove_chronology_or_semantics(self):
        # All receipts here are synthetic. A lying owner can construct a valid
        # chain after the fact; only run-time adoption can prevent send-ahead.
        state, _, _ = self.run_mock_owner()
        self.assertEqual(self.replay(state), state)
        self.assertNotIn("timestamp", state.document()["journal"][0])
        self.assertNotIn("semantic_accepted", state.document()["snapshot"])

    def test_no_runner_network_filesystem_or_process_imports(self):
        tree = ast.parse(inspect.getsource(T))
        modules = {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}
        modules.update(alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names)
        self.assertEqual(modules, {"dataclasses", "hashlib", "json", "re"})


if __name__ == "__main__":
    unittest.main()
