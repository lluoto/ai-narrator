"""Offline synthetic fixtures and pinned-code parity; no real case review or API calls."""
import ast
import copy
import itertools
from pathlib import Path
import socket
import subprocess
import tempfile
import types
import unittest
from unittest import mock

import jsonschema


ROOT = Path(__file__).absolute().parents[1]
TOOL = ROOT / "tools/luna_review_identity_v2.py"
V2 = types.ModuleType("luna_identity_v2_test")
V2.__file__ = str(TOOL)
exec(compile(TOOL.read_bytes(), str(TOOL), "exec"), V2.__dict__)
ORIGINAL_SOURCE = (ROOT / V2.ORIGINAL_TOOL).read_bytes()
SCHEMA_V1 = V2.load_original_schema(ORIGINAL_SOURCE)
# Extract only pure V1 functions, never execute the original module or its runner.
TREE = ast.parse(ORIGINAL_SOURCE)
NAMESPACE = {}
exec(compile(ast.Module(body=[n for n in TREE.body if isinstance(n, ast.FunctionDef) and
                             n.name in ("require", "response_schema", "validate_response")],
                        type_ignores=[]), str(V2.ORIGINAL_TOOL), "exec"), NAMESPACE)
VALIDATE_V1 = NAMESPACE["validate_response"]
CASE = {"case_id": "fixture:0", "status": "reviewable", "allowed_review_ids": [
    {"review_id": "sent:original:0:0", "sent_vs_context": "sent"},
    {"review_id": "context:0", "sent_vs_context": "context"}]}


def response():
    return {"case_id": CASE["case_id"], "reviewer_class": "model_delegated",
            "actual_executor": copy.deepcopy(V2.ACTUAL_EXECUTOR),
            "new_source_judgment": "supported", "abstain": False,
            "recommendation_only": "undecided", "support_scope": "new_review_context_only",
            "citations": [{"review_id": "context:0", "sent_vs_context": "context"}],
            "checks": [{"dimension": "source_fidelity", "judgment": "supported"}],
            "public_evidence_summary": "Synthetic fixture conclusion, not a real case verdict.",
            "no_runtime_effect": True}


def accepted(validator, value, case):
    try:
        validator(value, case)
        return True
    except (ValueError, TypeError, KeyError):
        return False


class IdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema = V2.response_schema_v2(SCHEMA_V1, [CASE["case_id"]])
        jsonschema.Draft202012Validator.check_schema(cls.schema)
        cls.structural = jsonschema.Draft202012Validator(cls.schema)

    def assert_identity_result(self, executor, expected):
        value = response()
        value["actual_executor"] = executor
        self.assertEqual(accepted(V2.validate_response_v2, value, CASE), expected)
        self.assertEqual(self.structural.is_valid(value), expected)

    def test_null_unknown_does_not_block_nonabstaining_supported_review(self):
        self.assert_identity_result(copy.deepcopy(V2.ACTUAL_EXECUTOR), True)
        with mock.patch.object(Path, "open", side_effect=AssertionError("validator must be pure")):
            V2.validate_response_v2(response(), CASE)

    def test_exposed_version_accepts_only_real_version_shape_with_matching_status(self):
        for version in ("environment-build-42", "2026-10-17.1"):
            self.assert_identity_result({**V2.ACTUAL_EXECUTOR, "version": version,
                                         "version_status": "exposed_by_environment"}, True)
        for version, status in itertools.product(
                (None, "environment-build-42"),
                ("not_exposed_by_environment", "exposed_by_environment", "unknown", None, [], 1)):
            with self.subTest(version=version, status=status):
                self.assert_identity_result({**V2.ACTUAL_EXECUTOR, "version": version,
                                             "version_status": status},
                                            (version is None and status == "not_exposed_by_environment") or
                                            (version == "environment-build-42" and status == "exposed_by_environment"))

    def test_identity_mismatch_placeholders_modelcopy_and_missing_keys_rejected(self):
        for field in V2.ACTUAL_EXECUTOR:
            value = copy.deepcopy(V2.ACTUAL_EXECUTOR)
            del value[field]
            self.assert_identity_result(value, False)
        self.assert_identity_result({**V2.ACTUAL_EXECUTOR, "evidence": "pretend"}, False)
        for obj in (None, [], "openai/gpt-6-luna", 42, {1: "unknown"}):
            self.assert_identity_result(obj, False)
        for field in ("provider", "model"):
            for wrong in (None, "", "unknown", "null", "OpenAI", "gpt-6", [], {}):
                self.assert_identity_result({**V2.ACTUAL_EXECUTOR, field: wrong}, False)
        for bad in ("", " ", "\t\n", "null", "NULL", " unknown ", "none", "N/A",
                    "undefined", "not_exposed_by_environment", "gpt-6-luna", " GPT-6-LUNA ",
                    "openai/gpt-6-luna", "OPENAI/GPT-6-LUNA", 1, False, [], {}):
            for status in ("exposed_by_environment", "not_exposed_by_environment"):
                with self.subTest(version=bad, status=status):
                    self.assert_identity_result({**V2.ACTUAL_EXECUTOR, "version": bad,
                                                 "version_status": status}, False)

    def test_schema_changes_only_actual_executor_and_does_not_mutate_v1(self):
        original = SCHEMA_V1([CASE["case_id"]])
        before = copy.deepcopy(original)
        patched = V2.response_schema_v2(lambda _: original, [CASE["case_id"]])
        self.assertEqual(original, before)
        patched["properties"]["actual_executor"] = before["properties"]["actual_executor"]
        self.assertEqual(patched, before)
        self.assertEqual(set(self.schema["properties"]), V2.RESPONSE_FIELDS)
        self.assertEqual(set(SCHEMA_V1(["x"])["properties"]["checks"]["items"]["properties"]
                             ["dimension"]["enum"]), set(V2.DIMENSIONS))
        for field, choices in V2.ENUMS.items():
            self.assertEqual(tuple(before["properties"][field]["enum"]), choices)

    def assert_parity(self, value, case=CASE, expected=None):
        # Same synthetic exposed version in both; only remove V2's new status field.
        v2 = copy.deepcopy(value)
        if isinstance(v2, dict) and "actual_executor" in v2:
            v2["actual_executor"] = {**V2.ACTUAL_EXECUTOR, "version": "fixture-build-42",
                                     "version_status": "exposed_by_environment"}
        v1 = copy.deepcopy(v2)
        if isinstance(v1, dict) and "actual_executor" in v1:
            del v1["actual_executor"]["version_status"]
        old = accepted(VALIDATE_V1, v1, case)
        new = accepted(V2.validate_response_v2, v2, case)
        self.assertEqual(new, old, (value, case))
        if expected is not None:
            self.assertEqual(new, expected)

    def test_all_identity_independent_fields_and_malformed_shapes_parity(self):
        for field in V2.RESPONSE_FIELDS - {"actual_executor"}:
            value = response()
            del value[field]
            self.assert_parity(value, expected=False)
        for obj in (None, [], "object", 1, {1: "bad"}, {**response(), "unknown": 1}):
            self.assert_parity(obj, expected=False)
            with self.assertRaises(ValueError):
                V2.validate_response_v2(obj, CASE)
        negatives = {
            "case_id": ("other-case", None, []),
            "reviewer_class": ("human", None, []),
            "no_runtime_effect": (False, 1, "true", None),
            "abstain": (1, "false", None, []),
            "public_evidence_summary": ("", " \t\n", None, 1, []),
            "new_source_judgment": ("entailed", None, [], {}),
            "recommendation_only": ("effective", None, [], {}),
            "support_scope": ("source", None, [], {}),
            "checks": (None, {}, "checks", [None], [1], [[]], [{}],
                       [{"dimension": "route"}], [{"judgment": "supported"}],
                       [{"dimension": "bad", "judgment": "supported"}],
                       [{"dimension": "route", "judgment": "bad"}],
                       [{"dimension": [], "judgment": "supported"}],
                       [{"dimension": "route", "judgment": "supported", "unknown": True}]),
            "citations": (None, {}, "citations", [None], [1], [[]], [{}],
                          [{"review_id": "context:0"}], [{"sent_vs_context": "context"}],
                          [{"review_id": "historical_vote", "sent_vs_context": "context"}],
                          [{"review_id": "other-case:0", "sent_vs_context": "context"}],
                          [{"review_id": "context:0", "sent_vs_context": "sent"}],
                          [{"review_id": [], "sent_vs_context": "context"}],
                          [{"review_id": "context:0", "sent_vs_context": []}],
                          [{"review_id": "context:0", "sent_vs_context": "context", "unknown": 1}])}
        for field, candidates in negatives.items():
            for bad in candidates:
                with self.subTest(field=field, bad=bad):
                    value = response()
                    value[field] = bad
                    self.assert_parity(value, expected=False)
                    with self.assertRaises(ValueError):
                        V2.validate_response_v2(value, CASE)
        for dimension, judgment in itertools.product(V2.DIMENSIONS, V2.JUDGMENTS):
            value = response()
            value["checks"] = [{"dimension": dimension, "judgment": judgment}]
            self.assert_parity(value, expected=True)

    def test_judgment_recommendation_scope_citation_and_blocked_cross_product_parity(self):
        citation_sets = [[], [CASE["allowed_review_ids"][0]], [CASE["allowed_review_ids"][1]],
                         CASE["allowed_review_ids"]]
        for judgment, recommendation, scope, citations in itertools.product(
                V2.JUDGMENTS, V2.ENUMS["recommendation_only"], V2.ENUMS["support_scope"], citation_sets):
            value = response()
            value.update(new_source_judgment=judgment, recommendation_only=recommendation,
                         support_scope=scope, citations=citations)
            self.assert_parity(value)
        for status in ("blocked_source", "blocked_integrity"):
            case = {**CASE, "status": status}
            blocked = response()
            blocked.update(new_source_judgment="needs_context", abstain=True,
                           recommendation_only="undecided", support_scope="none", citations=[], checks=[])
            self.assert_parity(blocked, case, True)
            V2.validate_response_v2(blocked, case)
            for field, bad in (("abstain", False), ("new_source_judgment", "insufficient"),
                               ("recommendation_only", "original"), ("support_scope", "both"),
                               ("citations", CASE["allowed_review_ids"]),
                               ("checks", [{"dimension": "route", "judgment": "needs_context"}])):
                self.assert_parity({**blocked, field: bad}, case, False)
        for judgment in ("supported", "contradicted"):
            with self.assertRaisesRegex(ValueError, "evidence_required"):
                V2.validate_response_v2({**response(), "new_source_judgment": judgment,
                                         "citations": [], "support_scope": "none"}, CASE)


class OverlayTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.parent = self.root / V2.PARENT
        self.parent.mkdir(parents=True)
        self.out = self.root / V2.OUT
        for name in (*V2.OWN_FILES, V2.ORIGINAL_TOOL.as_posix(), "tests/test_luna_conflict_review.py"):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            # Only code is copied; parent packet is entirely synthetic.
            path.write_bytes((ROOT / name).read_bytes())
        self.secret = "SYNTHETIC_SOURCE_PROSE_MUST_NOT_BE_COPIED"
        ids = [f"fixture:{i}" for i in range(713)]
        products = {"README.md": b"synthetic readme\n", "prompt.md": b"synthetic frozen prompt\n",
                    "report.json": V2.encoded({"count": 713}),
                    "executor_registration.json": V2.encoded({"actual_version": None}),
                    "schema_sampler.json": V2.encoded({"synthetic": True}),
                    "verdict_schema.json": V2.encoded(SCHEMA_V1(ids)),
                    "reviewed_cases.jsonl": b"".join(V2.encoded({"case_id": i, "text": self.secret}) for i in ids),
                    "shards/shard_0001.jsonl": V2.encoded({"text": self.secret}),
                    "shard_index.json": V2.encoded([{"path": "shards/shard_0001.jsonl"}])}
        for name, data in products.items():
            path = self.parent / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        refs = []
        for name in (V2.ORIGINAL_TOOL.as_posix(), "tests/test_luna_conflict_review.py"):
            data = (self.root / name).read_bytes()
            refs.append({"path": name, "sha256": V2.sha(data), "bytes": len(data)})
        self.manifest = {"schema": "luna_conflict_review_preparation.v1",
                         "output_directory": self.parent.as_posix(),
                         "counts": {"status_conflict_rows": 713}, "code_files": refs,
                         "shards": [{"path": "shards/shard_0001.jsonl"}],
                         "outputs": {name: {"sha256": V2.sha(data), "bytes": len(data)}
                                     for name, data in products.items()}}
        self.write_manifest()
        # Production constants are never overridable by CLI; only fixtures replace this pin.
        self.pin_patch = mock.patch.object(V2, "PARENT_PIN", V2.sha((self.parent / "manifest.json").read_bytes()))
        self.pin_patch.start()
        self.addCleanup(self.pin_patch.stop)
        for target in ((socket.socket, "connect"), (socket, "create_connection"),
                       (subprocess, "Popen"), (V2.os, "system")):
            patch = mock.patch.object(*target, side_effect=AssertionError("network/process forbidden"))
            patch.start()
            self.addCleanup(patch.stop)

    def write_manifest(self):
        (self.parent / "manifest.json").write_bytes(V2.encoded(self.manifest))

    def snapshot(self):
        return {p.relative_to(self.root).as_posix(): (p.read_bytes(), p.stat().st_mtime_ns)
                for p in self.root.rglob("*") if p.is_file()}

    def test_dry_materialize_external_pin_check_immutable_no_source_copy(self):
        before = self.snapshot()
        result = V2.build(self.root)
        self.assertFalse(self.out.exists())
        self.assertEqual(before, self.snapshot())
        products, manifest = V2.compile_overlay(self.root)
        self.assertNotIn(self.secret.encode(), b"".join(products.values()))
        self.assertEqual(set(products), {"manifest.json", "identity_policy.json", "verdict_schema_v2.json",
                                         "executor_record_template.json", "prompt_addendum.md"})
        self.assertEqual(len(V2.strict(products["verdict_schema_v2.json"])["properties"]["case_id"]["enum"]), 713)
        self.assertEqual(manifest["original_tool"]["sha256"], V2.ORIGINAL_TOOL_PIN)
        allowed = {str(V2.PARENT / name).replace("\\", "/") for name in
                   (*self.manifest["outputs"], "manifest.json")}
        allowed.update((*V2.OWN_FILES, *(r["path"] for r in self.manifest["code_files"])))
        self.assertEqual({r["path"] for r in manifest["input_files"]}, allowed)
        policy = V2.strict(products["identity_policy.json"])
        self.assertFalse(policy["transport_verified"])
        self.assertFalse(policy["unknown_version_blocks_review"])
        self.assertFalse(policy["exposed_version_evidence_verified_by_validator"])
        record = V2.strict(products["executor_record_template.json"])
        self.assertEqual(record["actual_executor"], V2.ACTUAL_EXECUTOR)
        self.assertEqual(record["execution_status"], "not_started")
        self.assertIsNone(record["actual_review_record"])
        self.assertEqual(record["completed_review_count"], 0)
        made = V2.build(self.root, materialize=True)
        self.assertEqual(made["manifest_sha256"], result["manifest_sha256"])
        after = self.snapshot()
        self.assertTrue(all(after[k] == v for k, v in before.items()))
        checked = V2.build(self.root, check=True, manifest_sha256=made["manifest_sha256"])
        self.assertEqual(checked["mode"], "check")
        self.assertEqual(after, self.snapshot())
        self.assertFalse(any(p.suffix == ".pyc" or p.name == "__pycache__" for p in self.root.rglob("*")))
        for key, value in V2.BOUNDARIES.items():
            self.assertEqual(checked[key], value)
        with self.assertRaisesRegex(ValueError, "existing_output_forbidden"):
            V2.build(self.root, materialize=True)

    def test_parent_pin_and_every_output_hash_enforced_before_write(self):
        for name in ("manifest.json", *self.manifest["outputs"]):
            with self.subTest(name=name):
                path = self.parent / name
                before = path.read_bytes()
                path.write_bytes(before + b" ")
                with self.assertRaisesRegex(ValueError, "input_hash_mismatch"):
                    V2.build(self.root, materialize=True)
                self.assertFalse(self.out.exists())
                path.write_bytes(before)
        path = self.root / V2.ORIGINAL_TOOL
        path.write_bytes(path.read_bytes() + b"\n")
        with self.assertRaisesRegex(ValueError, "input_hash_mismatch"):
            V2.build(self.root, materialize=True)
        self.assertFalse(self.out.exists())

    def test_parent_membership_and_paths_fail_closed(self):
        extra = self.parent / "extra.json"
        extra.write_bytes(b"{}")
        with self.assertRaisesRegex(ValueError, "parent_output_membership"):
            V2.build(self.root)
        extra.unlink()
        for path in ("../outside", "runs/../outside", "runs/NUL", "runs/a.",
                     "runs/a:b", "//server/share", "D:/absolute", "runs//empty"):
            with self.assertRaises(ValueError):
                V2.safe_path(self.root, path)

    def test_parent_declared_path_size_and_original_code_pin_are_checked(self):
        for mutation, code in (("path", "parent_output_path_mismatch"),
                               ("size", "input_size_mismatch"),
                               ("tool", "original_tool_pin_mismatch")):
            with self.subTest(mutation=mutation):
                parent = copy.deepcopy(self.manifest)
                if mutation == "path":
                    parent["outputs"]["prompt.md"]["path"] = "../outside.md"
                elif mutation == "size":
                    parent["outputs"]["prompt.md"]["bytes"] += 1
                else:
                    # Even a re-pinned parent cannot bless a different original tool.
                    path = self.root / V2.ORIGINAL_TOOL
                    source = path.read_bytes()
                    path.write_bytes(source + b"\n")
                    parent["code_files"][0].update(sha256=V2.sha(source + b"\n"), bytes=len(source) + 1)
                data = V2.encoded(parent)
                (self.parent / "manifest.json").write_bytes(data)
                with mock.patch.object(V2, "PARENT_PIN", V2.sha(data)):
                    with self.assertRaisesRegex(ValueError, code):
                        V2.build(self.root, materialize=True)
                self.assertFalse(self.out.exists())
                if mutation == "tool":
                    path.write_bytes(source)
        self.write_manifest()

    def test_external_pin_required_tampering_and_membership_rejected(self):
        made = V2.build(self.root, materialize=True)
        for pin in (None, "bad", "0" * 64):
            with self.assertRaises(ValueError):
                V2.build(self.root, check=True, manifest_sha256=pin)
        with self.assertRaisesRegex(ValueError, "incompatible_modes"):
            V2.build(self.root, materialize=True, check=True)
        with self.assertRaisesRegex(ValueError, "manifest_pin_only_for_check"):
            V2.build(self.root, manifest_sha256=made["manifest_sha256"])
        path = self.out / "identity_policy.json"
        data = path.read_bytes()
        path.write_bytes(data + b" ")
        with self.assertRaisesRegex(ValueError, "output_byte_mismatch"):
            V2.build(self.root, check=True, manifest_sha256=made["manifest_sha256"])
        path.write_bytes(data)
        (self.out / "extra.json").write_bytes(b"{}")
        with self.assertRaisesRegex(ValueError, "overlay_membership_mismatch"):
            V2.build(self.root, check=True, manifest_sha256=made["manifest_sha256"])

    def test_original_loader_is_pin_guarded_and_never_executes_module(self):
        with self.assertRaisesRegex(ValueError, "original_tool_pin_mismatch"):
            V2.load_original_schema(ORIGINAL_SOURCE + b"\n")
        self.assertEqual(SCHEMA_V1(["fixture"]), V2.load_original_schema(ORIGINAL_SOURCE)(["fixture"]))
        _, manifest = V2.compile_overlay(self.root)
        path = self.parent / "prompt.md"
        path.write_bytes(path.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "input_changed_final_hash"):
            V2.final_check(self.root, manifest)


if __name__ == "__main__":
    unittest.main()
