"""Synthetic, offline regressions for the approved derived-snapshot boundary."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest import mock


PATH = Path(__file__).resolve().parents[1] / "tools/materialize_deduplicated_source.py"
SPEC = importlib.util.spec_from_file_location("materialize_deduplicated_source", PATH)
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class MaterializeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "exact_audit_ref" / "original.jsonl"
        self.source.parent.mkdir()
        self.audit = self.root / M.AUDIT
        self.audit.mkdir(parents=True)
        self.out = self.root / M.OUT
        self.bundle = self.out / M.WORK
        self.base = {"sentence_id": "B001:S1", "source_id": "original_id", "text": "PRIVATE_SOURCE",
                     "work_id": "B001", "source_char_start": 12, "source_char_end": 26,
                     "chapter_char_start": 3, "source_hash": None}

    def freeze(self, raw=None, mutate_group=None):
        if self.out.exists():
            shutil.rmtree(self.out)
        if raw is None:
            a = M.encoded(self.base)
            b = M.encoded({**self.base, "sentence_id": "B001:S2"})
            c = M.encoded({**self.base, "sentence_id": "B001:S3"})[:-1]
            raw = a + b + a + a + b + c
        self.source.write_bytes(raw)
        self.original_bytes = raw
        refs, offset, groups = {}, 0, []
        for line, record in enumerate(io.BytesIO(raw), 1):
            row = M.strict(M.payload(record))
            refs.setdefault(row["sentence_id"], []).append(M.locator(record, line, offset))
            offset += len(record)
        source = {"path": self.source.as_posix(), **M.file_pin(self.source)}
        for sid, locs in sorted(refs.items()):
            if len(locs) == 1:
                continue
            group = {"sentence_id_sha256": M.digest(M.encoded(sid)[:-1]), "original_line_refs": locs,
                     "multiplicity": len(locs), "work_scope": M.WORK, "source_path": source["path"],
                     "source_file_sha256": source["sha256"], "category": "byte_identical_rows",
                     "raw_row_hash_multiplicities": {locs[0]["raw_lf_row_sha256"]: len(locs)}}
            if mutate_group:
                mutate_group(group)
            group["group_sha256"] = M.digest(M.encoded(group)[:-1])
            groups.append(group)
        self.report = {
            "work_scope": M.WORK, "source_snapshot": source,
            "full_source": {"bytes": len(raw), "physical_lf_rows": sum(map(len, refs.values())),
                            "nonblank_rows": sum(map(len, refs.values())), "valid_sentence_rows": sum(map(len, refs.values())),
                            "distinct_sentence_ids": len(refs), "blank_rows": 0, "malformed_rows": 0},
            "whole_file_duplicates": {"duplicate_id_groups": len(groups),
                                      "excess_id_occurrences": sum(len(v) - 1 for v in refs.values()),
                                      "rows_in_duplicate_groups": sum(len(v) for v in refs.values() if len(v) > 1),
                                      "multiplicity_histogram": {str(n): sum(len(v) == n for v in refs.values())
                                                                 for n in sorted({len(v) for v in refs.values() if len(v) > 1})},
                                      "category_groups": {"byte_identical_rows": len(groups)}}}
        (self.audit / "report.json").write_bytes(M.encoded(self.report))
        (self.audit / "groups.jsonl").write_bytes(b"".join(map(M.encoded, groups)))
        audit_manifest = {"root": self.root.as_posix(), "work_scope": M.WORK, "inputs": [source],
                          "outputs": {name: M.file_pin(self.audit / name) for name in ("report.json", "groups.jsonl")}}
        (self.audit / "manifest.json").write_bytes(M.encoded(audit_manifest))
        self.audit_pin = M.digest(M.encoded(audit_manifest))
        return raw

    def run_bundle(self, materialize=False):
        return M.run(self.root, M.AUDIT, self.audit_pin, M.OUT, materialize)

    def check(self, result):
        return M.check(self.root, self.bundle, result["manifest_sha256"], self.audit_pin)

    def test_first_occurrence_order_complete_lineage_counts_and_no_original_mutation(self):
        self.freeze()
        before = {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        dry = self.run_bundle()
        self.assertFalse(self.out.exists())
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()})
        result = self.run_bundle(True)
        self.assertEqual(dry["manifest_sha256"], result["manifest_sha256"])
        self.assertEqual(self.source.read_bytes(), self.original_bytes)
        self.assertEqual(before, {p: p.read_bytes() for p in before})
        self.assertEqual(result["counts"]["original_rows"], 6)
        self.assertEqual(result["counts"]["derived_rows"], 3)
        self.assertEqual(result["counts"]["removed_occurrences"], 3)
        lineage = [M.strict(raw) for raw in (self.bundle / "occurrence_lineage.jsonl").read_bytes().splitlines()]
        self.assertEqual([row["derived"]["line"] for row in lineage], [1, 2, 1, 1, 2, 3])
        self.assertEqual([row["original"]["line"] for row in lineage], list(range(1, 7)))
        self.assertEqual([row["disposition"] for row in lineage],
                         ["retained_first_occurrence"] * 2 + ["duplicate_of_first_occurrence"] * 3 +
                         ["retained_first_occurrence"])
        self.assertEqual(lineage[2]["duplicate_of_original_line"], 1)
        self.assertEqual(lineage[0]["source_work_fields"], {"work_id": "B001"})
        self.assertEqual(lineage[-1]["terminator_hex"], "")
        original_rows = list(io.BytesIO(self.original_bytes))
        self.assertEqual((self.bundle / "sentences_deduplicated.jsonl").read_bytes(),
                         original_rows[0] + original_rows[1] + original_rows[-1])
        self.assertTrue(self.check(result)["original_available"])
        final = M.strict((self.bundle / "manifest.json").read_bytes())
        self.assertEqual(final["inputs_before"], final["inputs_after"])
        self.assertEqual(final["source_before"], final["source_after"])
        self.assertEqual(final["authorization"]["user_text"], "1\uff0c2\u6279\u51c6")
        self.assertFalse(final["source_namespace_mapping_approved"])
        self.assertFalse(final["original_generator_binding_repaired"])
        with self.assertRaisesRegex(ValueError, "new_absent_output_directory"):
            self.run_bundle(True)

    def test_lf_crlf_unterminated_differences_reject_with_only_incomplete_audit(self):
        record = M.encoded(self.base)[:-1]
        for first, second in ((b"\n", b"\r\n"), (b"\r\n", b"\n"), (b"\n", b""), (b"\r\n", b"")):
            with self.subTest(first=first, second=second):
                self.freeze(record + first + record + second)
                with self.assertRaisesRegex(ValueError, "same_id_nonidentical_raw_record"):
                    self.run_bundle(True)
                self.assertEqual({p.name for p in self.bundle.iterdir()}, {"attempt.json"})
                self.assertFalse(M.strict((self.bundle / "attempt.json").read_bytes())["accepted"])
                self.assertEqual(self.source.read_bytes(), self.original_bytes)

    def test_text_identical_provenance_conflicts_and_key_order_conflicts(self):
        for field, value in (("source_char_start", 99), ("source_hash", "other"), ("work_id", "other")):
            self.freeze(M.encoded(self.base) + M.encoded({**self.base, field: value}))
            with self.assertRaisesRegex(ValueError, "same_id_nonidentical_raw_record"):
                self.run_bundle(True)
        other_encoding = json.dumps(dict(reversed(list(self.base.items())))).encode() + b"\n"
        self.freeze(M.encoded(self.base) + other_encoding)
        with self.assertRaisesRegex(ValueError, "same_id_nonidentical_raw_record"):
            self.run_bundle(True)

    def test_unicode_line_characters_are_not_physical_rows_and_crlf_preserved(self):
        row = {**self.base, "text": "a\u2028b\u2029c\u0085d\nESCAPED"}
        record = json.dumps(row, ensure_ascii=False).encode("utf-8") + b"\r\n"
        self.freeze(record * 2)
        result = self.run_bundle(True)
        self.assertEqual(result["counts"]["original_rows"], 2)
        self.assertEqual((self.bundle / "sentences_deduplicated.jsonl").read_bytes(), record)
        self.check(result)

    def test_duplicate_audit_hash_and_locator_mismatches_reject(self):
        for mutate in (lambda g: g.update(raw_row_hash_multiplicities={"0" * 64: g["multiplicity"]}),
                       lambda g: g["original_line_refs"][0].update(byte_offset=999)):
            self.freeze(mutate_group=mutate)
            with self.assertRaisesRegex(ValueError, "audit_duplicate_hash_mismatch|audit_duplicate_locator_mismatch"):
                self.run_bundle(True)
            self.assertEqual({p.name for p in self.bundle.iterdir()}, {"attempt.json"})

    def test_source_audit_tamper_and_manifest_external_pin(self):
        self.freeze()
        with self.source.open("ab") as handle:
            handle.write(b" ")
        with self.assertRaisesRegex(ValueError, "input_hash_mismatch"):
            self.run_bundle()
        self.freeze()
        with (self.audit / "groups.jsonl").open("ab") as handle:
            handle.write(b" ")
        with self.assertRaisesRegex(ValueError, "input_hash_mismatch"):
            self.run_bundle()
        self.freeze()
        result = self.run_bundle(True)
        with self.assertRaisesRegex(ValueError, "external_manifest_pin_required"):
            M.check(self.root, self.bundle, None, self.audit_pin)
        with self.assertRaisesRegex(ValueError, "output_manifest_hash_mismatch"):
            self.check({"manifest_sha256": "0" * 64})
        self.check(result)

    def test_output_tamper_detected_even_when_manifest_hashes_are_resealed(self):
        self.freeze()
        result = self.run_bundle(True)
        path = self.bundle / "occurrence_lineage.jsonl"
        rows = [M.strict(raw) for raw in path.read_bytes().splitlines()]
        rows[2]["retained_original_line"] = 2
        path.write_bytes(b"".join(map(M.encoded, rows)))
        with self.assertRaisesRegex(ValueError, "output_hash_mismatch"):
            self.check(result)
        final_path = self.bundle / "manifest.json"
        final = M.strict(final_path.read_bytes())
        final["outputs"][path.name] = M.file_pin(path)
        final_path.write_bytes(M.encoded(final))
        with self.assertRaisesRegex(ValueError, "lineage_replay_mismatch"):
            self.check({"manifest_sha256": M.digest(M.encoded(final))})

    def test_missing_lineage_occurrence_fails_reconstruction_after_reseal(self):
        self.freeze()
        self.run_bundle(True)
        path = self.bundle / "occurrence_lineage.jsonl"
        rows = path.read_bytes().splitlines(keepends=True)
        path.write_bytes(b"".join(rows[:-1]))
        final_path = self.bundle / "manifest.json"
        final = M.strict(final_path.read_bytes())
        final["outputs"][path.name] = M.file_pin(path)
        final_path.write_bytes(M.encoded(final))
        with self.assertRaisesRegex(ValueError, "original_rows_missing_from_lineage|unreferenced_derived_bytes"):
            self.check({"manifest_sha256": M.digest(M.encoded(final))})

    def test_reconstruction_without_original(self):
        self.freeze()
        result = self.run_bundle(True)
        self.source.unlink()
        checked = self.check(result)
        self.assertFalse(checked["original_available"])
        self.assertEqual(checked["counts"], result["counts"])

    def test_traversal_outside_scope_and_missing_parent(self):
        self.freeze()
        for path in ("../escape", self.root.parent / "escape"):
            with self.assertRaisesRegex(ValueError, "unsafe_path|path_outside_root"):
                M.safe_path(self.root, path)
        with self.assertRaisesRegex(ValueError, "output_not_owned_directory"):
            M.run(self.root, M.AUDIT, self.audit_pin, "other", True)
        with self.assertRaisesRegex(ValueError, "check_not_owned_directory"):
            M.check(self.root, self.root / "other", "0" * 64, self.audit_pin)
        (self.audit / "manifest.json").unlink()
        manifest = {"root": self.root.as_posix(), "work_scope": M.WORK, "inputs": [],
                    "outputs": {name: M.file_pin(self.audit / name) for name in ("report.json", "groups.jsonl")}}
        # An authenticated metadata path still cannot escape the root.
        report = {**self.report, "source_snapshot": {"path": "../escape", "sha256": "0" * 64}}
        (self.audit / "report.json").write_bytes(M.encoded(report))
        manifest["outputs"]["report.json"] = M.file_pin(self.audit / "report.json")
        (self.audit / "manifest.json").write_bytes(M.encoded(manifest))
        with self.assertRaisesRegex(ValueError, "unsafe_path"):
            M.Context(self.root, M.AUDIT, M.digest(M.encoded(manifest)))

    def test_missing_output_parent_rejected_without_creating_it(self):
        self.freeze()
        moved = self.root / "pinned_audit"
        self.audit.rename(moved)
        self.out.parent.rmdir()
        with self.assertRaisesRegex(ValueError, "new_absent_output_directory_parent_required"):
            M.run(self.root, moved, self.audit_pin, M.OUT, True)
        self.assertFalse(self.out.parent.exists())

    def test_output_name_traversal_rejected_even_with_resealed_manifest(self):
        self.freeze()
        self.run_bundle(True)
        path = self.bundle / "manifest.json"
        final = M.strict(path.read_bytes())
        final["outputs"]["../escape"] = final["outputs"].pop("occurrence_lineage.jsonl")
        path.write_bytes(M.encoded(final))
        with self.assertRaisesRegex(ValueError, "unsafe_output_names"):
            self.check({"manifest_sha256": M.digest(M.encoded(final))})

    def test_actual_duplicate_slice_hash_mismatch(self):
        self.freeze()
        parse = M.source_row
        calls = 0

        def mutate_first_slice(raw):
            nonlocal calls
            calls += 1
            if calls == 3:
                with self.source.open("r+b") as handle:
                    handle.write(b"X")
            return parse(raw)

        with mock.patch.object(M, "source_row", mutate_first_slice):
            with self.assertRaisesRegex(ValueError, "source_slice_hash_mismatch"):
                self.run_bundle(True)
        self.assertTrue((self.bundle / "attempt.json").is_file())
        self.assertFalse((self.bundle / "manifest.json").exists())

    def test_malformed_json_and_duplicate_keys_rejected(self):
        for raw in (b'{"sentence_id":"one","sentence_id":"two","text":"x"}\n',
                    b'{"sentence_id":"one","text":null}\n', b'[]\n', b'\n'):
            # Parsing never chooses a key or guesses an ID from a malformed row.
            with self.assertRaises((ValueError, TypeError)):
                M.source_row(raw)

    def test_changed_source_slice_fails_and_incomplete_attempt_is_retained(self):
        self.freeze()
        original_scan = M.scan
        calls = 0

        def fail_after_preflight(ctx, bundle=None):
            nonlocal calls
            calls += 1
            if bundle:
                with (bundle / "occurrence_lineage.jsonl").open("xb") as handle:
                    handle.write(b"partial\n")
                raise ValueError("source_slice_hash_mismatch")
            return original_scan(ctx, bundle)

        with mock.patch.object(M, "scan", fail_after_preflight):
            with self.assertRaisesRegex(ValueError, "source_slice_hash_mismatch"):
                self.run_bundle(True)
        self.assertEqual(calls, 2)
        self.assertTrue((self.bundle / "attempt.json").is_file())
        self.assertFalse(M.strict((self.bundle / "attempt.json").read_bytes())["accepted"])
        self.assertFalse((self.bundle / "manifest.json").exists())
        self.assertEqual(self.source.read_bytes(), self.original_bytes)

    def test_cli_default_is_dry_run_and_unpinned_check_fails(self):
        self.freeze()
        with mock.patch.object(M, "Context") as ctx, mock.patch.object(M, "run", return_value={}) as run:
            ctx.return_value.source = {"sha256": M.SOURCE_PIN, "bytes": 69550897}
            ctx.return_value.report = {"full_source": {"physical_lf_rows": 99683, "distinct_sentence_ids": 71258},
                                       "whole_file_duplicates": {"duplicate_id_groups": 28425}}
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(M.main([]), 0)
            self.assertFalse(run.call_args.args[-1])
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(M.main(["--root", str(self.root), "--check", str(self.bundle)]), 1)


if __name__ == "__main__":
    unittest.main()
