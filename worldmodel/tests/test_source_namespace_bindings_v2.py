"""Synthetic offline fixtures for nearest-source scope; sealed V1 is read-only."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("namespace_audit_v2", Path(__file__).resolve().parents[1] /
                                             "tools/audit_source_namespace_bindings_v2.py")
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)
v1 = audit.v1


class NamespaceV2Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def write(self, relative, value, jsonl=False):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        data = (b"".join(json.dumps(row, sort_keys=True).encode("utf-8") + b"\n" for row in value)
                if jsonl else v1.encoded(value))
        path.write_bytes(data)
        return v1.file_pin(path)

    def fixture(self, work="Alpha"):
        base = "runs/" + work + "/index/"
        row = {"sentence_id": "B001:C0001:S1", "work_id": "B001", "chapter_id": "B001:C0001",
               "text": "DO_NOT_EMIT_PROSE"}
        source = self.write(base + "sentences.jsonl", [row], True)
        common = {"window_id": "w1", "work_id": work, "chapter_id": row["chapter_id"], "role": "rule_atom_read"}
        coverage = self.write(base + "coverage.jsonl", [{**common, "anchor_sentence_ids": [row["sentence_id"]],
                                                       "attached_sentence_ids": []}], True)
        generator = self.write(base + "generator.jsonl", [{**common, "sentence_ids": [row["sentence_id"]]}], True)
        pins = {"sentences.jsonl": source["sha256"], "coverage_partition.jsonl": coverage["sha256"]}
        job = self.write(base + "job.json", {"book": work, "input_artifact_hashes": pins})
        def short(ref):
            return {k: ref[k] for k in ("path", "sha256")}
        def loc(ref):
            return {"path": ref["path"], "file_sha256": ref["sha256"], "line": 1,
                    "row_sha256": v1.sha(Path(ref["path"]).read_bytes().rstrip(b"\r\n"))}
        artifacts = {"sentences": short(source), "coverage": short(coverage),
                     "generator": short(generator), "job": short(job)}
        windows = [{**common, "artifacts": artifacts, "audited_sentence_aliases": [short(source)],
                    "coverage_row": loc(coverage), "generator_rows": [loc(generator)],
                    "sentence_ids": [row["sentence_id"]], "original_execution_input_pins": pins,
                    "sentence_rows": [{**loc(source), "sentence_id": row["sentence_id"],
                                       "original_work_id": "B001", "original_chapter_id": row["chapter_id"]}],
                    "source_blockers": ["sentence_work_mismatch", "sentence_id_ambiguous"]}]
        chapter = self.write(base + "chapters.jsonl", [{"chapter_id": row["chapter_id"], "title": "NO_CHAPTER_PROSE"}], True)
        return windows, {"work_id": work, "source": short(source), "metadata": [chapter]}, short(source)

    def run_document(self, make_document, work="Alpha", historical=False, jsonl=False):
        windows, record, source = self.fixture(work)
        document = make_document(copy.deepcopy(source))
        metadata = self.write("runs/" + work + "/index/books." + ("jsonl" if jsonl else "json"),
                              [document] if jsonl else document, jsonl)
        record["metadata"].append(metadata)
        inputs = v1.Inputs(self.root)
        if historical:
            inputs.historical_pins[metadata["path"]] = metadata
        before = Path(source["path"]).read_bytes()
        result = audit.audit_work(inputs, work, windows, record)
        inputs.recheck()
        self.assertEqual(before, Path(source["path"]).read_bytes())
        self.assertNotIn("DO_NOT_EMIT_PROSE", json.dumps(result))
        self.assertNotIn("NO_CHAPTER_PROSE", json.dumps(result))
        self.assertEqual(result["boundaries"]["model_calls"], 0)
        self.assertEqual(result["boundaries"]["network_calls"], 0)
        self.assertFalse(result["boundaries"]["source_modified"])
        return result

    def book(self, **extra):
        return {"code": "B001", "title": "Alpha", **extra}

    def foreign(self, source):
        return dict(source, path="runs/Foreign/index/sentences.jsonl")

    def test_parent_correct_child_foreign_cannot_support(self):
        result = self.run_document(lambda s: {"source_snapshot": s,
            "books": [self.book(source_snapshot=self.foreign(s))]})
        self.assertEqual(result["status"], "conflicting_identity")
        relation = result["upstream_code_title_relationships"][0]
        self.assertFalse(relation["exact_source_snapshot_match"])
        self.assertEqual(relation["nearest_source_object_pointer"], "/books/0")
        self.assertEqual(len(relation["source_snapshot_references"]), 1)
        self.assertIn("metadata_source_snapshot_path_mismatch", result["conflicts"])

    def test_parent_inherited_when_child_has_no_source(self):
        result = self.run_document(lambda s: {"source_snapshot": s, "books": [self.book()]})
        self.assertEqual(result["status"], "supported_local_namespace_mapping")
        relation = result["upstream_code_title_relationships"][0]
        self.assertEqual(relation["nearest_source_object_pointer"], "")
        self.assertEqual(relation["source_snapshot_references"][0]["sha256_pointer"], "/source_snapshot/sha256")
        self.assertFalse(result["lineage_fully_confirmed"])

    def test_child_malformed_declaration_shadows_parent(self):
        malformed = (None, {}, "unstructured", [], {"path": "source"}, {"sha256": "0" * 64},
                     {"path": "", "sha256": "0" * 64}, {"path": "source", "sha256": "invalid"})
        for declaration in malformed:
            with self.subTest(declaration=declaration):
                result = self.run_document(lambda s: {"source_snapshot": s,
                    "books": [self.book(source_snapshot=declaration)]})
                self.assertEqual(result["status"], "unresolved")
                self.assertIn("malformed_nearest_source_declaration", result["incomplete_evidence"])
                relation = result["upstream_code_title_relationships"][0]
                self.assertFalse(relation["exact_source_snapshot_match"])
                self.assertEqual(relation["source_snapshot_references"], [])
                self.assertEqual(result["source_binding_diagnostics"][0]["pointer"], "/books/0/source_snapshot")

    def test_either_flat_source_key_is_explicit_and_shadows(self):
        for extra in ({"source_path": "source"}, {"source_sha256": "0" * 64}, {"source_path": None}):
            with self.subTest(extra=extra):
                result = self.run_document(lambda s: {"source_snapshot": s, "books": [self.book(**extra)]})
                self.assertEqual(result["status"], "unresolved")
                self.assertFalse(result["upstream_code_title_relationships"][0]["exact_source_snapshot_match"])

    def test_all_named_source_keys_shadow_even_when_malformed(self):
        for key in ("source", "source_snapshot", "sentence_source", "original_source"):
            with self.subTest(key=key):
                result = self.run_document(lambda s: {"source_snapshot": s, "books": [self.book(**{key: {}})]})
                self.assertEqual(result["status"], "unresolved")

    def test_multiple_identical_references_are_allowed(self):
        result = self.run_document(lambda s: self.book(source_snapshot=s, source=dict(s),
            source_path=s["path"], source_sha256=s["sha256"]))
        self.assertEqual(result["status"], "supported_local_namespace_mapping")
        relation = result["upstream_code_title_relationships"][0]
        self.assertEqual(len(relation["source_snapshot_references"]), 3)
        self.assertTrue(relation["nearest_source_unique_valid_pin"])
        self.assertFalse(relation["source_binding_diagnostics"])

    def test_different_refs_one_matching_is_ambiguous(self):
        result = self.run_document(lambda s: self.book(source_snapshot=s, original_source=self.foreign(s)))
        self.assertEqual(result["status"], "unresolved")
        self.assertIn("ambiguous_nearest_source_declaration", result["incomplete_evidence"])
        self.assertFalse(result["upstream_code_title_relationships"][0]["exact_source_snapshot_match"])
        self.assertFalse(result["lineage_fully_confirmed"])

    def test_same_path_different_hash_is_ambiguous(self):
        result = self.run_document(lambda s: self.book(source_snapshot=s, source=dict(s, sha256="0" * 64)))
        self.assertEqual(result["status"], "unresolved")
        self.assertIn("ambiguous_nearest_source_declaration", result["incomplete_evidence"])

    def test_normalized_path_aliases_are_not_literal_equivalence(self):
        result = self.run_document(lambda s: self.book(source_snapshot=s,
            source=dict(s, path=str(Path(s["path"]).relative_to(self.root)).replace("\\", "/"))))
        self.assertEqual(result["status"], "unresolved")
        self.assertIn("ambiguous_nearest_source_declaration", result["incomplete_evidence"])

    def test_matching_plus_malformed_same_object_is_not_supported(self):
        result = self.run_document(lambda s: self.book(source_snapshot=s, original_source={}))
        self.assertEqual(result["status"], "unresolved")
        relation = result["upstream_code_title_relationships"][0]
        self.assertEqual(len(relation["source_snapshot_references"]), 1)
        self.assertFalse(relation["nearest_source_unique_valid_pin"])

    def test_child_correct_replaces_wrong_parent(self):
        result = self.run_document(lambda s: {"source_snapshot": self.foreign(s),
            "books": [self.book(source_snapshot=s)]})
        self.assertEqual(result["status"], "supported_local_namespace_mapping")
        self.assertFalse(result["conflicts"])

    def test_child_correct_replaces_ambiguous_parent(self):
        result = self.run_document(lambda s: {"source_snapshot": s, "original_source": self.foreign(s),
            "books": [self.book(source_snapshot=s)]})
        self.assertEqual(result["status"], "supported_local_namespace_mapping")
        self.assertFalse(result["source_binding_diagnostics"])

    def test_child_correct_replaces_malformed_parent(self):
        result = self.run_document(lambda s: {"source_snapshot": {}, "books": [self.book(source_snapshot=s)]})
        self.assertEqual(result["status"], "supported_local_namespace_mapping")

    def test_intermediate_malformed_scope_is_inherited_not_grandparent(self):
        result = self.run_document(lambda s: {"source_snapshot": s, "group": {"source": None,
            "books": [self.book()]}})
        self.assertEqual(result["status"], "unresolved")
        self.assertEqual(result["upstream_code_title_relationships"][0]["nearest_source_object_pointer"], "/group")

    def test_sibling_context_does_not_leak(self):
        result = self.run_document(lambda s: {"source_snapshot": s, "books": [self.book(source=None), self.book()]})
        relations = result["upstream_code_title_relationships"]
        self.assertFalse(relations[0]["exact_source_snapshot_match"])
        self.assertTrue(relations[1]["exact_source_snapshot_match"])
        self.assertEqual(result["status"], "unresolved")

    def test_wrong_single_hash_conflicts(self):
        result = self.run_document(lambda s: self.book(source_snapshot=dict(s, sha256="0" * 64)))
        self.assertEqual(result["status"], "conflicting_identity")
        self.assertIn("metadata_source_snapshot_hash_mismatch", result["conflicts"])

    def test_no_source_is_candidate_not_supported(self):
        result = self.run_document(lambda s: self.book())
        self.assertEqual(result["status"], "mapping_candidate_needs_approval")

    def test_source_only_without_code_title_pair_is_not_proof(self):
        result = self.run_document(lambda s: {"source_snapshot": s, "code": "B001", "nested": {"title": "Alpha"}})
        self.assertEqual(result["status"], "mapping_candidate_needs_approval")
        self.assertFalse(result["upstream_code_title_relationships"])

    def test_historical_support_still_requires_nearest_match(self):
        result = self.run_document(lambda s: {"source_snapshot": s,
            "books": [self.book(source_snapshot=self.foreign(s))]}, historical=True)
        self.assertFalse(result["lineage_fully_confirmed"])
        result = self.run_document(lambda s: {"source_snapshot": s, "books": [self.book()]}, historical=True)
        self.assertTrue(result["lineage_fully_confirmed"])

    def test_jsonl_metadata_retains_explicit_location(self):
        result = self.run_document(lambda s: {"source_snapshot": s, "books": [self.book(source_snapshot={})]}, jsonl=True)
        self.assertEqual(result["status"], "unresolved")
        self.assertEqual(result["source_binding_diagnostics"][0]["pointer"], "/line/1/books/0/source_snapshot")

    def test_colliding_local_codes_remain_work_and_snapshot_scoped(self):
        a = self.run_document(lambda s: self.book(source_snapshot=s))
        b = self.run_document(lambda s: {"code": "B001", "title": "Beta", "source_snapshot": s}, work="Beta")
        self.assertNotEqual(a["proposed_bindings"][0]["key"], b["proposed_bindings"][0]["key"])
        self.assertEqual(a["status"], b["status"])
        self.assertFalse(a["proposed_bindings"][0]["global_alias"])
        self.assertFalse(a["proposed_bindings"][0]["applied"])

    def test_reproduction_and_duplicate_blocker_metadata_preserved(self):
        first = self.run_document(lambda s: self.book(source_snapshot=s))
        second = self.run_document(lambda s: self.book(source_snapshot=s))
        self.assertEqual(v1.encoded(first), v1.encoded(second))
        self.assertEqual(first["retained_inventory_blockers"][0]["metadata"]["source_blockers"],
                         ["sentence_work_mismatch", "sentence_id_ambiguous"])
        self.assertNotIn("byte_identical", json.dumps(first))

    def test_pinned_loader_rejects_changed_code_before_execution(self):
        path = self.root / "untrusted.py"
        path.write_bytes(b"raise RuntimeError('must not execute')\n")
        with self.assertRaisesRegex(ValueError, "sealed_v1_implementation_hash_mismatch"):
            audit.load_v1(path)

    def test_v1_behavior_and_globals_are_not_mutated(self):
        doc = {"source_snapshot": {"path": "a", "sha256": "a" * 64}, "books": [self.book(
            source_snapshot={"path": "b", "sha256": "b" * 64})]}
        original_function = v1.metadata_fields
        original = v1.metadata_fields(doc, "metadata.json")
        fixed = audit.metadata_fields(doc, "metadata.json")
        self.assertEqual(len(original[1][0]["source_snapshot_references"]), 2)
        self.assertEqual(len(fixed[1][0]["source_snapshot_references"]), 1)
        self.assertIs(v1.metadata_fields, original_function)
        self.assertEqual(v1.metadata_fields(doc, "metadata.json"), original)

    def cli(self, *extra):
        out = self.root / "v2"
        argv = ["audit", "--inventory", "inventory", "--manifest-sha256", v1.SEALED,
                "--metadata-inventory", "metadata.json", "--metadata-sha256", "a" * 64,
                "--out-dir", str(out), *extra]
        outputs = {"manifest.json": v1.encoded({"test": True}), "report.json": b"{}\n"}
        report = {"counts": {}, "diagnostic_supersession": {"status_counts_unchanged": True}}
        with mock.patch.object(audit, "ROOT", self.root), mock.patch.object(audit, "OUT", Path("v2")), \
                mock.patch.object(v1, "load_scope", return_value={}), \
                mock.patch.object(audit, "build", return_value=(outputs, report)), \
                mock.patch("sys.argv", argv), contextlib.redirect_stdout(io.StringIO()) as stdout:
            audit.main()
        return out, json.loads(stdout.getvalue())

    def test_cli_default_is_read_only_and_materialization_is_absent_only(self):
        out, response = self.cli()
        self.assertEqual(response["mode"], "dry_run")
        self.assertFalse(out.exists())
        _, response = self.cli("--materialize", "newabsent")
        with self.assertRaisesRegex(ValueError, "output_directory_already_exists"):
            self.cli("--materialize", "newabsent")
        _, checked = self.cli("--check", "newaudit", "--audit-manifest-sha256", response["manifest_sha256"])
        self.assertEqual(checked["mode"], "check")
        with self.assertRaisesRegex(ValueError, "external_output_manifest_pin_required"):
            self.cli("--check", "newaudit")
        with self.assertRaisesRegex(ValueError, "input_hash_mismatch"):
            self.cli("--check", "newaudit", "--audit-manifest-sha256", "0" * 64)


if __name__ == "__main__":
    unittest.main()
