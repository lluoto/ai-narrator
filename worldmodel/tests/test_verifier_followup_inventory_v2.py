"""Pinned V1 regressions plus V2 container-shape and sealed-output checks."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "tools/build_verifier_followup_inventory_v2.py"
SPEC = importlib.util.spec_from_file_location("verifier_followup_inventory_v2_tests", PATH)
B = importlib.util.module_from_spec(SPEC)
exec(compile(PATH.read_bytes(), str(PATH), "exec"), B.__dict__)
FIXTURE = B.V1.load_module("verifier_inventory_v1_test_fixture_pinned",
                          ROOT / "tests/test_verifier_followup_inventory.py", B.V1_TEST_PIN)


class InventoryV2Tests(FIXTURE.InventoryTests):
    def setUp(self):
        patch = mock.patch.object(FIXTURE, "B", B)
        patch.start()
        self.addCleanup(patch.stop)
        super().setUp()

    def malformed_attempt(self, attempt, field, value):
        """Repin the entire synthetic chain, so container validation is exercised."""
        self.other_valid = True
        self.freeze()
        inventory = [B.strict(raw) for raw in (self.audit / "input_hashes.jsonl").read_bytes().splitlines()]
        rec = B.strict((self.audit / "card_reconciliation.jsonl").read_bytes().splitlines()[0])
        comparison = B.strict((self.audit / "reverify_comparison.jsonl").read_bytes().splitlines()[0])
        queue = [B.strict(raw) for raw in (self.audit / "verifier_repair_queue.jsonl").read_bytes().splitlines()]
        key = "original" if attempt == "original" else "reverify"
        locator = rec[key][0]["attempt_artifact"]
        path = locator["path"]
        row = B.strict((self.root / path).read_bytes().splitlines()[0])
        if field == "owner":
            row = value
        elif field == "verifier":
            row["verifier"] = value
        else:
            row["verifier"]["call_meta"] = value
        data = B.jsonl([row])
        new_ref = self.put(path, data)
        new_locator = {**locator, "file_sha256": new_ref["sha256"], "row_sha256": B.digest(B.canonical(row))}
        for item in inventory:
            if item["path"] == path:
                item.update(new_ref)
        for records in (rec[key], comparison[key], queue):
            for entry in records:
                if entry["attempt"] == attempt:
                    entry["attempt_artifact"] = copy.deepcopy(new_locator)
        products = {"input_hashes.jsonl": B.jsonl(inventory), "card_reconciliation.jsonl": B.jsonl([rec]),
                    "reverify_comparison.jsonl": B.jsonl([comparison]), "verifier_repair_queue.jsonl": B.jsonl(queue)}
        for name, data in products.items():
            self.pins[name] = self.put("audit/" + name, data)["sha256"]

    def assert_deferred_shape(self, attempt, field, value, reason):
        self.malformed_attempt(attempt, field, value)
        row, = self.build()
        self.assertEqual(row["decision"], B.PARTITIONS[3])
        self.assertIn(reason, row["reason_codes"])
        self.assertEqual(row["preparation_status"], "not_prepared")
        self.assertEqual(row["max_future_8001_calls_if_explicitly_authorized"], 0)
        self.assertFalse(row["valid_other_counterpart_exists"])
        self.assertEqual(len(self.builder.accounting), 1)
        self.assertEqual(self.builder.accounting[0]["attempt_verified"], attempt != "original")
        if attempt != "original":
            old, = row["existing_other_attempt_statuses"]
            self.assertFalse(old["verified"])
            self.assertEqual(old["audited_status"], "insufficient")

    def test_malformed_nonempty_call_meta_origin_list_and_string(self):
        for value in (["PRIVATE_BAD_META"], "PRIVATE_BAD_META"):
            with self.subTest(value_type=type(value).__name__):
                self.assert_deferred_shape("original", "call_meta", value, "attempt_call_meta_not_object")

    def test_malformed_nonempty_call_meta_counterpart_list_and_string(self):
        for value in (["PRIVATE_BAD_META"], "PRIVATE_BAD_META"):
            with self.subTest(value_type=type(value).__name__):
                self.assert_deferred_shape("reverify_8001", "call_meta", value, "attempt_call_meta_not_object")

    def test_null_empty_and_scalar_call_meta_not_silently_coerced(self):
        for attempt in ("original", "reverify_8001"):
            for value in (None, [], "", False, 0, 1):
                with self.subTest(attempt=attempt, value=value):
                    self.assert_deferred_shape(attempt, "call_meta", value, "attempt_call_meta_not_object")

    def test_nonobject_verifier_origin_and_counterpart(self):
        for attempt in ("original", "reverify_8001"):
            for value in (["PRIVATE_BAD_VERIFIER"], "PRIVATE_BAD_VERIFIER", None):
                with self.subTest(attempt=attempt, value_type=type(value).__name__):
                    self.assert_deferred_shape(attempt, "verifier", value, "raw_response_missing")

    def test_nonobject_owner_origin_and_counterpart(self):
        for attempt in ("original", "reverify_8001"):
            for value in (["PRIVATE_BAD_OWNER"], "PRIVATE_BAD_OWNER", None):
                with self.subTest(attempt=attempt, value_type=type(value).__name__):
                    self.assert_deferred_shape(attempt, "owner", value, "malformed_source_record")

    def test_direct_owner_and_verifier_guard_before_inherited_accesses(self):
        builder = B.Builder(self.root, self.audit, {}, {}, {}, FIXTURE.CORE, FIXTURE.RULES, expected_count=1)
        entry = {"attempt_artifact": {}, "card_id": "W1#0"}
        for row, code in ((["owner"], "attempt_owner_not_object"), ("owner", "attempt_owner_not_object"),
                          ({"verifier": ["verifier"]}, "attempt_verifier_not_object"),
                          ({"verifier": "verifier"}, "attempt_verifier_not_object")):
            with self.subTest(code=code), mock.patch.object(builder, "locator", return_value=(row, {}, {})):
                with self.assertRaisesRegex(ValueError, "^" + code + "$"):
                    builder.verify_attempt(entry, {}, {}, {}, {})

    def test_pinned_v1_crash_reproduced_without_changing_v1(self):
        self.malformed_attempt("original", "call_meta", ["PRIVATE_BAD_META"])
        original_builder = B.Builder.__bases__[0]
        builder = original_builder(self.root, self.audit, self.pins, {}, {}, FIXTURE.CORE, FIXTURE.RULES, expected_count=1)
        with self.assertRaises(AttributeError):
            builder.compile()
        row, = self.build()
        self.assertEqual(row["decision"], B.PARTITIONS[3])

    def test_v1_code_tests_and_all_sealed_output_pins_preserved(self):
        inputs = B.Inputs(ROOT)
        manifest = B.strict(inputs.read(B.V1_MANIFEST, B.V1_MANIFEST_PIN))
        inputs.read(B.V1_PATH, B.V1_CODE_PIN)
        inputs.read(ROOT / "tests/test_verifier_followup_inventory.py", B.V1_TEST_PIN)
        for name, pin in manifest["outputs"].items():
            data = inputs.read(B.V1_MANIFEST.with_name(name), pin["sha256"])
            self.assertEqual(len(data), pin["bytes"])
        inputs.recheck()


if __name__ == "__main__":
    unittest.main()
