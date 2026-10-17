"""Exact binding regressions plus unchanged v2/v1 offline validator regressions."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest import mock

import test_generation_followup_inventory_v2 as fixture

PATH = Path(__file__).resolve().parents[1] / "tools/build_generation_followup_inventory_v3.py"
SPEC = importlib.util.spec_from_file_location("generation_followup_inventory_v3", PATH)
B = importlib.util.module_from_spec(SPEC)
exec(compile(PATH.read_bytes(), str(PATH), "exec"), B.__dict__)


class InventoryV3Tests(fixture.InventoryV2Tests):
    def setUp(self):
        super().setUp()
        # V3 owns a separately loaded pinned v2 module, with the same safe temp core.
        for name, value in (("CORE", self.root / "core.py"), ("BUILDER", self.root / "builder.py")):
            patch = mock.patch.object(B.V2, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        self.bindings = {}
        self.identity_refs = {label: {"path": "synthetic/" + label, "sha256": str(i) * 64}
                              for i, label in enumerate(("manifest", "authorization", "records"), 1)}
        self.last_builder = None

    def build(self):
        self.last_builder = B.Builder(self.root, self.audit, self.pins, self.prior,
                                      bindings=self.bindings, identity_refs=self.identity_refs)
        return self.last_builder.compile()

    def approve(self, *, work=None, sha=None, local="B001"):
        work = self.work if work is None else work
        sha = B.V2.file_hash(self.root / self.sp) if sha is None else sha
        key = (work, sha, local)
        self.bindings[key] = {
            "approved": True, "key": dict(zip(B.IDENTITY.KEY_FIELDS, key)),
            "artifacts": {label: {"path": (self.root / path).as_posix(),
                                   "sha256": B.V2.file_hash(self.root / path)}
                          for label, path in (("job", self.jp), ("generator", self.gp), ("coverage", self.cp))},
        }

    def local_source(self):
        self.sentences[0].update(work_id="B001", source_char_start=19, source_char_end=24)

    def test_exact_binding_releases_only_identity_and_does_not_mutate_any_input(self):
        self.local_source()
        self.coverage[0]["work_id"] = self.work
        self.gens[0]["work_id"] = self.work
        self.freeze()
        self.approve()
        before = {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        original_core = B.V2.load_core((self.root / "core.py").read_bytes())
        seen = []
        def checked(record, sources):
            seen.append(copy.deepcopy(sources))
            self.assertEqual(sources[self.sid], {**self.sentences[0], "work_id": self.work})
            return original_core["build_window"](record, sources)
        core = {**original_core, "build_window": checked}
        with mock.patch.object(B.V2, "load_core", return_value=core):
            products, report = self.build()
        row, = self.rows(products)
        self.assertTrue(seen)
        self.assertIn("span_out_of_bounds", row["reason_codes"])
        self.assertTrue(row["source_identity_projection"]["performed"])
        self.assertFalse(row["source_identity_projection"]["originals_mutated"])
        self.assertFalse(row["source_identity_projection"]["semantic_truth_proven"])
        receipt, = row["source_identity_binding"]
        self.assertEqual(receipt["original_work_id"], "B001")
        self.assertEqual(receipt["named_scope"], self.work)
        self.assertEqual(receipt["sidecar_manifest"], self.identity_refs["manifest"])
        self.assertEqual(receipt["authorization"], self.identity_refs["authorization"])
        self.assertEqual(row["sentence_rows"][0]["original_work_id"], "B001")
        self.assertEqual(row["grouping_key"][3], B.V2.file_hash(self.root / self.sp))
        self.assertTrue(all(c["current_card_validation_performed"] for c in row["original_cards"]))
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()})
        index = self.last_builder.inputs.rows((self.root / self.sp).as_posix(),
                                             row["grouping_key"][3], "sentence_id")
        self.assertEqual(index[self.sid][0][0], self.sentences[0])
        self.assertEqual(report["model_calls"], 0)

    def test_other_work_hash_local_id_or_unknown_tuple_never_aliases_B001(self):
        self.local_source()
        self.freeze()
        for change in ({"work": "other_book"}, {"sha": "0" * 64}, {"local": "B002"}, {}):
            with self.subTest(change=change):
                self.bindings.clear()
                if change:
                    self.approve(**change)
                row, = self.rows(self.build()[0], 2)
                self.assertIn("sentence_work_mismatch", row["source_blockers"])
                self.assertEqual(row["source_identity_binding"], [])
                self.assertFalse(row["source_identity_projection"]["performed"])

    def test_derived_file_hash_does_not_inherit_original_approval(self):
        self.local_source()
        self.freeze()
        self.approve()
        original_hash = B.V2.file_hash(self.root / self.sp)
        self.sentences[0]["source_char_start"] += 1
        self.freeze()
        row, = self.rows(self.build()[0], 2)
        self.assertNotEqual(original_hash, row["grouping_key"][3])
        self.assertIn("sentence_work_mismatch", row["source_blockers"])

    def test_approval_does_not_remove_duplicate_missing_or_crosschapter_blockers(self):
        self.local_source()
        original = copy.deepcopy(self.sentences)
        cases = {"duplicate": "sentence_id_ambiguous", "missing": "sentence_id_missing",
                 "chapter": "sentence_binding_mismatch"}
        for case, expected in cases.items():
            with self.subTest(case=case):
                self.sentences = copy.deepcopy(original)
                self.coverage[0]["attached_sentence_ids"] = []
                self.gens[0]["sentence_ids"] = [self.sid]
                if case == "duplicate":
                    self.sentences.append(copy.deepcopy(self.sentences[0]))
                if case == "missing":
                    sid = "B001:C0001:S000002"
                    self.coverage[0]["attached_sentence_ids"] = [sid]
                    self.gens[0]["sentence_ids"].append(sid)
                if case == "chapter":
                    self.sentences[0]["chapter_id"] = "B001:C9999"
                self.freeze()
                self.bindings.clear()
                self.approve()
                row, = self.rows(self.build()[0], 2)
                self.assertIn(expected, row["source_blockers"])
                self.assertFalse(row["source_identity_projection"]["performed"])

    def test_extra_unapproved_raw_local_tuple_defers_entire_window(self):
        self.local_source()
        sid = "B001:C0001:S000002"
        self.sentences.append({**self.sentences[0], "sentence_id": sid, "work_id": "B002"})
        self.coverage[0]["attached_sentence_ids"] = [sid]
        self.gens[0]["sentence_ids"].append(sid)
        self.freeze()
        self.approve()
        row, = self.rows(self.build()[0], 2)
        self.assertIn("sentence_work_mismatch", row["source_blockers"])
        self.assertEqual(len(row["source_identity_binding"]), 1)
        self.assertFalse(row["source_identity_projection"]["performed"])

    def test_raw_queue_job_generator_coverage_checks_precede_projection(self):
        self.local_source()
        mutations = [lambda q: q[0]["attempt_artifact"].update(row_sha256="0" * 64),
                     lambda q: q[0]["attempt_artifact"].update(file_sha256="0" * 64)]
        for mutation in mutations:
            self.freeze(mutate_queue=mutation)
            self.bindings.clear()
            self.approve()
            row, = self.rows(self.build()[0], 2)
            self.assertFalse(row["source_identity_projection"]["performed"])
        self.freeze()
        self.approve()
        (self.root / self.jp).write_bytes(b"{}\n")
        row, = self.rows(self.build()[0], 2)
        self.assertIn("source_hash_mismatch", row["source_blockers"])
        self.assertFalse(row["source_identity_projection"]["performed"])

    def test_approved_now_valid_cards_offline_not_forced_to_candidates(self):
        self.local_source()
        self.gens = [self.generator("W1", [False], valid=True)]
        self.freeze()
        self.approve()
        row, = self.rows(self.build()[0], 1)
        self.assertIn("normalization_mismatch_preserved", row["observations"])
        self.assertIn("rejected_card_now_structurally_valid", row["observations"])
        self.assertFalse(row["original_cards"][0]["original_accepted_for_verification"])

    def test_missing_or_changed_approved_original_source_still_defers(self):
        self.local_source()
        self.freeze()
        self.approve()
        source = self.root / self.sp
        original = source.read_bytes()
        for changed in (None, b"{}\n"):
            with self.subTest(changed=changed):
                source.write_bytes(original)
                if changed is None:
                    source.unlink()
                else:
                    source.write_bytes(changed)
                row, = self.rows(self.build()[0], 2)
                self.assertFalse(row["source_identity_projection"]["attempted"])
                self.assertFalse(row["source_identity_projection"]["performed"])
                self.assertIn("missing_source" if changed is None else "source_hash_mismatch", row["source_blockers"])

    def test_local_id_collision_across_works_requires_both_exact_hashes(self):
        self.local_source()
        self.freeze()
        self.approve()
        first = {name: (self.audit / name).read_bytes() for name in self.pins}
        old_work = self.work
        self.work = "second_work"
        for attr in ("gp", "jp", "cp", "sp"):
            setattr(self, attr, getattr(self, attr).replace(old_work, self.work))
        self.sentences[0]["text"] += "different"
        self.freeze()
        self.approve()
        second_report = json.loads((self.audit / "report.json").read_bytes())
        combined = {
            "manifest.json": B.V2.encoded({"cohorts": {"wave_a": [old_work, self.work]}}),
            "generator_repair_queue.jsonl": first["generator_repair_queue.jsonl"] + (self.audit / "generator_repair_queue.jsonl").read_bytes(),
            "input_hashes.jsonl": first["input_hashes.jsonl"] + (self.audit / "input_hashes.jsonl").read_bytes(),
        }
        report = json.loads(first["report.json"])
        report["generator_repair_queue_rows"] = 2
        report["historical_input_hash_checks"] += second_report["historical_input_hash_checks"]
        combined["report.json"] = B.V2.encoded(report)
        for name, data in combined.items():
            self.pins[name] = self.put("audit/" + name, data)
        products, _ = self.build()
        rows = self.rows(products)
        self.assertEqual(len(rows), 2)
        self.assertEqual(len({r["group_id"] for r in rows}), 2)
        self.assertEqual(len({r["grouping_key"][3] for r in rows}), 2)
        self.assertTrue(all(r["source_identity_projection"]["performed"] for r in rows))
        self.bindings.pop(next(key for key in self.bindings if key[0] == self.work))
        products, _ = self.build()
        self.assertEqual(len(self.rows(products)), 1)
        self.assertEqual(self.rows(products, 2)[0]["work_id"], self.work)

    def test_reconciliation_preserves_originals_and_rejects_nonidentity_release(self):
        self.local_source()
        self.freeze()
        self.approve()
        self.build()
        previous = {key: json.loads(raw) for key, raw in self.last_builder.raw_baseline.items()}
        result = B.reconcile(self.last_builder, previous)
        self.assertEqual(result["candidate_increment"], 1)
        self.assertTrue(result["original_lineage_and_group_keys_preserved"])
        self.last_builder.windows[0]["grouping_key"][3] = "0" * 64
        with self.assertRaisesRegex(ValueError, "original_lineage_changed"):
            B.reconcile(self.last_builder, previous)

    def test_v3_external_check_pin_is_required_before_build(self):
        with mock.patch.object(B, "build", side_effect=AssertionError("must not build")):
            with mock.patch("sys.stderr"):
                self.assertEqual(B.main(["--check"]), 1)
                self.assertEqual(B.main(["--check", "--manifest-sha256", "0" * 64]), 1)

    def test_v3_absent_only_materialize_manifest_last_and_external_check(self):
        self.freeze()
        products, report = self.build()
        report = {**report, "reconciliation": {}}
        guard = mock.Mock()
        out = self.root / "v3_output"
        pin = B.V2.digest(products["manifest.json"])
        with mock.patch.object(B, "OUT", out), mock.patch.object(B, "build", return_value=(products, report, (guard,))):
            with mock.patch("sys.stdout"), mock.patch("sys.stderr"):
                self.assertEqual(B.main(["--materialize", "newabsent"]), 0)
                self.assertEqual(B.main(["--materialize", "newabsent"]), 1)
                self.assertEqual(B.main(["--check", "--manifest-sha256", pin]), 0)
                (out / "entry_accounting.jsonl").write_bytes(b"tampered")
                self.assertEqual(B.main(["--check", "--manifest-sha256", pin]), 1)
        self.assertEqual(guard.recheck.call_count, 1)
        failed = self.root / "failed_v3_output"
        guard.recheck.side_effect = ValueError("input_changed_during_build")
        with mock.patch.object(B, "OUT", failed), mock.patch.object(B, "build", return_value=(products, report, (guard,))):
            with mock.patch("sys.stderr"):
                self.assertEqual(B.main(["--materialize", "newabsent"]), 1)
        self.assertFalse((failed / "manifest.json").exists())


if __name__ == "__main__":
    unittest.main()
