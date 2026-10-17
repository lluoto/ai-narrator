"""Temporary structured fixtures only; no production inputs or runner imports."""
import importlib.util
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    "source_namespace_audit", Path(__file__).resolve().parents[1] / "tools/audit_source_namespace_bindings.py")
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


class NamespaceAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.inputs = audit.Inputs(self.root)

    def write(self, relative, value, jsonl=False):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        data = (b"".join(audit.encoded(r).replace(b"\n", b"") + b"\n" for r in value)
                if jsonl else audit.encoded(value))
        path.write_bytes(data)
        return audit.file_pin(path)

    def scan(self, rows, wanted=None):
        ref = self.write("runs/Alpha/index/sentences.jsonl", rows, True)
        return audit.scan_sentences(self.inputs, ref, wanted if wanted is not None else {rows[0]["sentence_id"]})

    def row(self, code="B001", chapter="B001:C0001", sid=None):
        return {"work_id": code, "chapter_id": chapter, "sentence_id": sid or chapter + ":S1", "text": "DO_NOT_REPORT_PROSE"}

    def classify(self, metadata, rows=None, incomplete=None, mismatches=None, source_pinned=True):
        ref = self.write("runs/Alpha/index/metadata.json", metadata)
        fields, relations = audit.metadata_fields(self.inputs.load(ref), ref["path"])
        # Classifier unit fixtures; audit_work integration fixtures verify actual path/hash pins.
        for relation in relations:
            relation["exact_source_snapshot_match"] = source_pinned
        scan = self.scan(rows or [self.row()])
        result = audit.classify("Alpha", scan, relations, fields, mismatches or [], incomplete or [])
        return result, fields, relations

    def test_matching_upstream_structured_code_title(self):
        result, fields, relations = self.classify({"books": [{"code": "B001", "title": "Alpha"}]})
        self.assertEqual(result[0], "supported_local_namespace_mapping")
        self.assertEqual(relations[0]["code_pointer"], "/books/0/code")
        self.assertEqual(relations[0]["title_pointer"], "/books/0/title")
        self.assertEqual(result[3]["B001"], "upstream_declared_local_book_code")
        self.assertEqual(len(fields), 2)

    def test_wrong_title_is_actual_conflict(self):
        result, _, _ = self.classify({"code": "B001", "title": "Other"})
        self.assertEqual(result[0], "conflicting_identity")
        self.assertIn("metadata_code_declares_different_title", result[1])

    def test_multiple_declared_codes_are_not_silently_selected(self):
        result, _, _ = self.classify({"books": [{"code": "B001", "title": "Alpha"},
                                                  {"code": "B002", "title": "Alpha"}]})
        self.assertEqual(result[0], "unresolved")
        self.assertIn("declared_codes_not_observed_in_pinned_source", result[2])
        self.assertFalse(result[1])

    def test_multiple_observed_codes_conflict(self):
        result, _, _ = self.classify({}, [self.row(), self.row("B002", "B002:C0001", "B002:C0001:S1")])
        self.assertEqual(result[0], "conflicting_identity")
        self.assertIn("multiple_observed_work_identifiers", result[1])

    def test_colliding_b001s_keep_work_and_source_scope(self):
        a = self.fixture("Alpha")
        b = self.fixture("Beta")
        first = audit.audit_work(self.inputs, "Alpha", a[0], a[1])
        second = audit.audit_work(self.inputs, "Beta", b[0], b[1])
        self.assertEqual(first["status"], "supported_local_namespace_mapping")
        self.assertEqual(second["status"], "supported_local_namespace_mapping")
        x, y = first["proposed_bindings"][0], second["proposed_bindings"][0]
        self.assertNotEqual(x["key"], y["key"])
        self.assertEqual(x["key"]["local_work_id"], y["key"]["local_work_id"])
        self.assertFalse(x["global_alias"])
        self.assertFalse(x["applied"])

    def test_no_metadata_is_candidate_not_proof(self):
        result, _, relations = self.classify({})
        self.assertEqual(result[0], "mapping_candidate_needs_approval")
        self.assertEqual(relations, [])
        self.assertIn("unproven", result[3]["B001"])

    def test_title_only_and_unrelated_objects_not_relationship(self):
        result, _, relations = self.classify({"book": {"title": "Alpha"}, "code": "B001"})
        self.assertEqual(result[0], "mapping_candidate_needs_approval")
        self.assertEqual(relations, [])

    def test_chapter_title_is_not_a_book_title(self):
        result, fields, relations = self.classify({"chapter_id": "B001:C0001", "title": "DO_NOT_REPORT_CHAPTER"})
        self.assertEqual(result[0], "mapping_candidate_needs_approval")
        self.assertEqual(fields, [])
        self.assertEqual(relations, [])

    def test_missing_namespace_unresolved_not_actual_mismatch(self):
        result, _, _ = self.classify({}, [self.row(None)])
        self.assertEqual(result[0], "unresolved")
        self.assertEqual(result[1], [])
        self.assertIn("missing_sentence_namespace_fields", result[2])
        self.assertEqual(result[3]["<missing>"], "missing")

    def test_foreign_work_code_conflicts_with_declared_namespace(self):
        result, _, _ = self.classify({"code": "B002", "title": "Alpha"})
        self.assertEqual(result[0], "conflicting_identity")
        self.assertIn("observed_code_absent_from_declared_namespace", result[1])

    def test_literal_title_is_not_treated_as_code_proof(self):
        result, _, relations = self.classify({}, [self.row("Alpha", "Alpha:C0001")])
        self.assertEqual(result[0], "mapping_candidate_needs_approval")
        self.assertEqual(result[3]["Alpha"], "literal_title_identifier_not_global_alias_proof")
        self.assertFalse(relations)

    def test_whole_file_not_only_selected_identifiers(self):
        scan = self.scan([self.row(), self.row("Foreign", "Foreign:C0002", "foreign")])
        self.assertEqual(scan["observed_work_id_frequencies"], {"B001": 1, "Foreign": 1})
        self.assertEqual(scan["selected_work_id_frequencies"], {"B001": 1})

    def test_duplicates_not_collapsed_or_equivalence_audited(self):
        first, second = self.row(), self.row()
        second["text"] = "DIFFERENT_PROSE_NOT_COMPARED"
        scan = self.scan([first, second])
        self.assertEqual(scan["total_rows"], 2)
        self.assertEqual(scan["observed_work_id_frequencies"], {"B001": 2})
        self.assertEqual(scan["duplicate_sentence_id_count"], 1)
        self.assertEqual(scan["duplicate_extra_row_count"], 1)
        self.assertEqual(len(scan["selected"]["B001:C0001:S1"]), 2)
        self.assertNotIn("text", scan["selected"]["B001:C0001:S1"][0])
        self.assertNotIn("equivalent", str(scan))

    def test_changed_source_rejected_before_reasoning(self):
        ref = self.write("source.jsonl", [self.row()], True)
        Path(ref["path"]).write_bytes(b"{}\n")
        with self.assertRaisesRegex(ValueError, "input_hash_mismatch"):
            audit.scan_sentences(self.inputs, ref, set())

    def test_changed_source_after_parse_rejected(self):
        ref = self.write("source.jsonl", [self.row()], True)
        audit.scan_sentences(self.inputs, ref, set())
        Path(ref["path"]).write_bytes(b"{}\n")
        with self.assertRaisesRegex(ValueError, "input_changed_after_parse"):
            self.inputs.recheck()

    def test_cache_one_parse_pass(self):
        ref = self.write("source.jsonl", [self.row()], True)
        first = audit.scan_sentences(self.inputs, ref, {"B001:C0001:S1"})
        self.inputs.rows = lambda *args, **kwargs: self.fail("unexpected second parse")
        self.assertIs(first, audit.scan_sentences(self.inputs, ref, {"B001:C0001:S1"}))
        self.inputs.recheck()

    def test_incomplete_evidence_distinct_from_actual_mismatch(self):
        result, _, _ = self.classify({"code": "B001", "title": "Alpha"},
                                      incomplete=["no_explicit_chapter_index"])
        self.assertEqual(result[0], "unresolved")
        self.assertEqual(result[1], [])
        self.assertEqual(result[2], ["no_explicit_chapter_index"])

    def test_actual_chapter_prefix_mismatch(self):
        result, _, _ = self.classify({"code": "B001", "title": "Alpha"},
                                      [self.row("B001", "B002:C0001")])
        self.assertEqual(result[0], "conflicting_identity")
        self.assertIn("sentence_work_id_vs_chapter_prefix_mismatch", result[1])

    def test_sentence_id_chapter_mismatch_is_observed_not_equivalence(self):
        result, _, _ = self.classify({}, [self.row(sid="B002:C0001:S1")])
        self.assertEqual(result[0], "conflicting_identity")
        self.assertIn("sentence_id_vs_chapter_id_mismatch", result[1])

    def test_malformed_metadata_preserves_hash_and_marks_incomplete(self):
        windows, metadata = self.fixture("Alpha")
        path = Path(metadata["metadata"][1]["path"])
        path.write_bytes(path.read_bytes() + b'6e7"}\n')
        metadata["metadata"][1] = audit.file_pin(path)
        result = audit.audit_work(self.inputs, "Alpha", windows, metadata)
        self.assertEqual(result["status"], "unresolved")
        self.assertEqual(result["conflicts"], [])
        self.assertIn("malformed_explicit_metadata", result["incomplete_evidence"])
        self.assertEqual(result["metadata_parse_issues"][0]["line"], 2)
        self.assertEqual(result["metadata_refs"][1]["sha256"], audit.file_pin(path)["sha256"])
        self.inputs.recheck()

    def test_foreign_source_directory_rejected(self):
        with self.assertRaisesRegex(ValueError, "foreign_source_directory"):
            audit.metadata_dirs(self.inputs, "Alpha", {"path": "runs/Beta/index/sentences.jsonl"})

    def test_strict_duplicate_keys_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicate_json_key"):
            audit.strict('{"work_id":"Alpha","work_id":"Beta"}')

    def fixture(self, work):
        base = "runs/" + work + "/index/"
        sentence = self.write(base + "sentences.jsonl", [self.row()], True)
        cov_row = {"window_id": "w1", "work_id": work, "chapter_id": "B001:C0001",
                   "anchor_sentence_ids": ["B001:C0001:S1"], "attached_sentence_ids": [], "role": "rule_atom_read"}
        gen_row = {"window_id": "w1", "work_id": work, "chapter_id": "B001:C0001",
                   "sentence_ids": ["B001:C0001:S1"], "role": "rule_atom_read"}
        coverage = self.write(base + "coverage.jsonl", [cov_row], True)
        generator = self.write(base + "generator.jsonl", [gen_row], True)
        job = self.write(base + "job.json", {"book": work, "input_artifact_hashes": {
            "sentences.jsonl": sentence["sha256"], "coverage_partition.jsonl": coverage["sha256"]}})
        def short(ref):
            return {k: ref[k] for k in ("path", "sha256")}
        refs = {"sentences": short(sentence), "coverage": short(coverage),
                "generator": short(generator), "job": short(job)}
        def loc(ref):
            raw = Path(ref["path"]).read_bytes().rstrip(b"\r\n")
            return {"path": ref["path"], "line": 1, "row_sha256": audit.sha(raw), "file_sha256": ref["sha256"]}
        windows = [{"window_id": "w1", "work_id": work, "chapter_id": "B001:C0001",
                    "artifacts": refs, "audited_sentence_aliases": [short(sentence)],
                    "coverage_row": loc(coverage), "generator_rows": [loc(generator)],
                    "sentence_ids": ["B001:C0001:S1"],
                    "original_execution_input_pins": {"sentences.jsonl": sentence["sha256"],
                                                      "coverage_partition.jsonl": coverage["sha256"]},
                    "sentence_rows": [{**loc(sentence), "sentence_id": "B001:C0001:S1",
                                       "original_work_id": "B001", "original_chapter_id": "B001:C0001"}]}]
        metadata = self.write(base + "metadata.json", {"code": "B001", "title": work, "source_snapshot": short(sentence)})
        chapter = self.write(base + "chapters.jsonl", [{"chapter_id": "B001:C0001", "title": "NOT_BOOK_PROSE"}], True)
        record = {"work_id": work, "source": short(sentence), "metadata": [metadata, chapter]}
        return windows, record

    def test_end_to_end_work_evidence_has_no_prose(self):
        windows, metadata = self.fixture("Alpha")
        before = Path(windows[0]["artifacts"]["sentences"]["path"]).read_bytes()
        result = audit.audit_work(self.inputs, "Alpha", windows, metadata)
        self.assertEqual(result["status"], "supported_local_namespace_mapping")
        self.assertEqual(result["exact_affected_window_count"], 1)
        self.assertEqual(result["deferred_window_count"], 1)
        self.assertNotIn("DO_NOT_REPORT", json.dumps(result))
        self.assertNotIn("NOT_BOOK_PROSE", json.dumps(result))
        self.assertEqual(before, Path(windows[0]["artifacts"]["sentences"]["path"]).read_bytes())
        self.inputs.recheck()

    def rewrite_metadata(self, record, transform):
        path = Path(record["metadata"][0]["path"])
        value = json.loads(path.read_bytes())
        transform(value)
        path.write_bytes(audit.encoded(value))
        record["metadata"][0] = audit.file_pin(path)

    def test_current_metadata_with_matching_source_is_qualified_support(self):
        windows, metadata = self.fixture("Alpha")
        result = audit.audit_work(self.inputs, "Alpha", windows, metadata)
        relation = result["upstream_code_title_relationships"][0]
        self.assertEqual(result["status"], "supported_local_namespace_mapping")
        self.assertTrue(relation["exact_source_snapshot_match"])
        self.assertEqual(relation["source_snapshot_references"][0]["sha256_pointer"], "/source_snapshot/sha256")
        self.assertEqual(relation["metadata_sha256"], metadata["metadata"][0]["sha256"])
        self.assertFalse(result["lineage_fully_confirmed"])
        self.assertEqual(relation["metadata_snapshot_kind"], "current_offline_pinned_only")

    def test_historically_pinned_metadata_and_source(self):
        windows, metadata = self.fixture("Alpha")
        ref = metadata["metadata"][0]
        self.inputs.historical_pins[ref["path"]] = ref
        result = audit.audit_work(self.inputs, "Alpha", windows, metadata)
        self.assertTrue(result["lineage_fully_confirmed"])

    def test_code_title_without_source_pin_is_candidate(self):
        windows, metadata = self.fixture("Alpha")
        self.rewrite_metadata(metadata, lambda v: v.pop("source_snapshot"))
        result = audit.audit_work(self.inputs, "Alpha", windows, metadata)
        self.assertEqual(result["status"], "mapping_candidate_needs_approval")
        self.assertFalse(result["lineage_fully_confirmed"])

    def test_metadata_wrong_source_hash_never_supported(self):
        windows, metadata = self.fixture("Alpha")
        self.rewrite_metadata(metadata, lambda v: v["source_snapshot"].update(sha256="0" * 64))
        result = audit.audit_work(self.inputs, "Alpha", windows, metadata)
        self.assertEqual(result["status"], "conflicting_identity")
        self.assertIn("metadata_source_snapshot_hash_mismatch", result["conflicts"])

    def test_metadata_foreign_source_path_not_support(self):
        windows, metadata = self.fixture("Alpha")
        self.rewrite_metadata(metadata, lambda v: v["source_snapshot"].update(path="runs/Beta/index/sentences.jsonl"))
        result = audit.audit_work(self.inputs, "Alpha", windows, metadata)
        self.assertEqual(result["status"], "mapping_candidate_needs_approval")

    def test_crosswork_title_only_declaration_conflicts(self):
        result, _, _ = self.classify({"title": "Beta"})
        self.assertEqual(result[0], "conflicting_identity")
        self.assertIn("crosswork_title_declaration", result[1])

    def test_missing_metadata_audit_completes_unresolved(self):
        windows, metadata = self.fixture("Alpha")
        metadata["metadata"] = []
        result = audit.audit_work(self.inputs, "Alpha", windows, metadata)
        self.assertEqual(result["status"], "unresolved")
        self.assertFalse(result["upstream_code_title_relationships"])

    def test_full_line_distributions_include_nonselected_rows(self):
        scan = self.scan([self.row(), self.row("B002", "B002:C0001"), self.row()])
        self.assertEqual(scan["work_id_line_ranges"], {"B001": [[1, 1], [3, 3]], "B002": [[2, 2]]})
        self.assertEqual(scan["chapter_frequencies"], {"B001:C0001": 2, "B002:C0001": 1})
        self.assertEqual(scan["sentence_id_multiplicity_histogram"], {1: 1, 2: 1})

    def test_lossless_all_sentence_identifier_counts_and_lines(self):
        rows = [self.row(sid="B001:C0001:S001"), self.row(sid="B001:C0001:S002"),
                self.row(sid="B001:C0001:S003"), self.row(sid="B001:C0001:S001"),
                self.row(sid="opaque-id")]
        scan = self.scan(rows)
        counts, locations = {}, {}
        def expand(run):
            if "sentence_id" in run:
                return [run["sentence_id"]]
            return [run["identifier_prefix"] + str(n).zfill(run["numeric_width"])
                    for n in range(run["first"], run["last"] + 1)]
        for run in scan["sentence_id_frequency_ranges"]:
            for sid in expand(run):
                counts[sid] = run["occurrences_per_identifier"]
        for run in scan["sentence_id_line_distribution"]:
            for line, sid in enumerate(expand(run), run["first_line"]):
                locations[line] = sid
        self.assertEqual(counts, {"B001:C0001:S001": 2, "B001:C0001:S002": 1,
                                 "B001:C0001:S003": 1, "opaque-id": 1})
        self.assertEqual(locations, {i: row["sentence_id"] for i, row in enumerate(rows, 1)})
        self.assertEqual(scan["sentence_id_line_distribution"][0]["last_line"], 3)

    def test_cache_ref_with_changed_pin_rejected(self):
        ref = self.write("source.jsonl", [self.row()], True)
        audit.scan_sentences(self.inputs, ref, set())
        with self.assertRaisesRegex(ValueError, "input_hash_mismatch"):
            audit.scan_sentences(self.inputs, dict(ref, sha256="0" * 64), set())

    def test_work_reproduction_is_deterministic_and_no_model(self):
        windows, metadata = self.fixture("Alpha")
        first = audit.audit_work(self.inputs, "Alpha", windows, metadata)
        second = audit.audit_work(audit.Inputs(self.root), "Alpha", windows, metadata)
        self.assertEqual(audit.encoded(first), audit.encoded(second))
        self.assertEqual(first["boundaries"]["model_calls"], 0)
        self.assertEqual(first["boundaries"]["network_calls"], 0)
        self.assertTrue(first["boundaries"]["no_runtime_effect"])

    def test_retains_duplicate_blocker_metadata_without_equivalence(self):
        windows, metadata = self.fixture("Alpha")
        windows[0]["source_blocker_reasons"] = ["duplicate_sentence_ids"]
        result = audit.audit_work(self.inputs, "Alpha", windows, metadata)
        self.assertEqual(result["retained_inventory_blockers"][0]["metadata"]["source_blocker_reasons"], ["duplicate_sentence_ids"])
        self.assertNotIn("byte_identical", json.dumps(result))

    def test_inventory_source_locator_mismatch_rejected(self):
        windows, metadata = self.fixture("Alpha")
        windows[0]["sentence_rows"][0]["line"] = 2
        with self.assertRaisesRegex(ValueError, "inventory_source_row_reference_mismatch"):
            audit.audit_work(self.inputs, "Alpha", windows, metadata)

    def test_wrong_title_in_pinned_metadata_is_conflict(self):
        windows, metadata = self.fixture("Alpha")
        self.rewrite_metadata(metadata, lambda v: v.update(title="Beta"))
        result = audit.audit_work(self.inputs, "Alpha", windows, metadata)
        self.assertEqual(result["status"], "conflicting_identity")

    def cli(self, *extra):
        out = self.root / "owned/completed"
        args = ["audit", "--inventory", "inventory", "--manifest-sha256", audit.SEALED,
                "--out-dir", str(out), *extra]
        outputs = {"manifest.json": audit.encoded({"test_manifest": True}), "report.json": b"{}\n"}
        with mock.patch.object(audit, "ROOT", self.root), mock.patch.object(audit, "OUT", Path("owned")), \
                mock.patch.object(audit, "load_scope", return_value={}), \
                mock.patch.object(audit, "build", return_value=(outputs, {"counts": {}})), \
                mock.patch("sys.argv", args), contextlib.redirect_stdout(io.StringIO()) as stdout:
            audit.main()
        return out, json.loads(stdout.getvalue()), outputs

    def test_cli_dryrun_default_creates_nothing(self):
        out, result, _ = self.cli()
        self.assertEqual(result["mode"], "dry_run")
        self.assertFalse(out.exists())

    def test_cli_materialize_absent_only_and_externally_pinned_check(self):
        (self.root / "owned").mkdir()
        out, result, outputs = self.cli("--materialize", "newabsent")
        self.assertTrue(out.is_dir())
        with self.assertRaisesRegex(ValueError, "output_directory_already_exists"):
            self.cli("--materialize", "newabsent")
        _, checked, _ = self.cli("--check", "newaudit", "--audit-manifest-sha256", result["manifest_sha256"])
        self.assertEqual(checked["mode"], "check")
        self.assertEqual(result["manifest_sha256"], checked["manifest_sha256"])
        (out / "report.json").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "output_not_reproducible"):
            self.cli("--check", "newaudit", "--audit-manifest-sha256", audit.sha(outputs["manifest.json"]))

    def test_cli_check_requires_correct_external_pin(self):
        (self.root / "owned").mkdir()
        self.cli("--materialize", "newabsent")
        with self.assertRaisesRegex(ValueError, "external_output_manifest_pin_required"):
            self.cli("--check", "newaudit")
        with self.assertRaisesRegex(ValueError, "input_hash_mismatch"):
            self.cli("--check", "newaudit", "--audit-manifest-sha256", "0" * 64)


if __name__ == "__main__":
    unittest.main()
