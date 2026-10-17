"""Owned, synthetic offline-only tests. No production scripts are imported."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import socket
import tempfile
import unittest
from unittest import mock


PATH = Path(__file__).resolve().parents[1] / "tools" / "build_generation_followup_inventory.py"
SPEC = importlib.util.spec_from_file_location("generation_followup_inventory", PATH)
B = importlib.util.module_from_spec(SPEC)
exec(compile(PATH.read_bytes(), str(PATH), "exec"), B.__dict__)
CORE_BYTES = B.CORE.read_bytes()


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.audit = self.root / "audit"
        self.audit.mkdir()
        self.work = "fixture_\u4e66"
        self.gp = "runs/canary/" + self.work + "/proposition_generator.jsonl"
        self.jp = str(Path(self.gp).with_name("job_record.json")).replace("\\", "/")
        self.cp = "runs/coverage/" + self.work + "/coverage_partition.jsonl"
        self.sp = "runs/" + self.work + "/source/sentences.jsonl"
        self.sid = "B001:C0001:S000001"
        self.coverage = [{"window_id": "W1", "chapter_id": "B001:C0001", "role": "rule_atom_read",
                          "anchor_sentence_ids": [self.sid], "attached_sentence_ids": []}]
        self.sentences = [{"sentence_id": self.sid, "chapter_id": "B001:C0001", "work_id": None,
                           "text": "\u539f\u6587\u4e00\u4e8c\u4e09"}]
        self.card = {"primary_route": "bounded_event", "proposition_text": "PRIVATE_PROPOSITION_\u4e8b\u4ef6",
                     "evidence_ids": [self.sid], "evidence_spans": [{"sentence_id": self.sid, "start": 0, "end": 2}],
                     "assertion_status": "narrator_asserted", "temporal_status": "bounded_occurrence",
                     "evidence_directness": "explicit", "content_facets": ["bounded_event"],
                     "generality_scope": "instance", "claimant_or_source": None}
        self.gens = [self.generator("W1", [False, True])]
        for leaf, data in (("core.py", CORE_BYTES), ("builder.py", PATH.read_bytes())):
            (self.root / leaf).write_bytes(data)
        self.core_patch = mock.patch.object(B, "CORE", self.root / "core.py")
        self.builder_patch = mock.patch.object(B, "BUILDER", self.root / "builder.py")
        self.core_patch.start()
        self.builder_patch.start()
        self.addCleanup(self.core_patch.stop)
        self.addCleanup(self.builder_patch.stop)
        self.network = mock.patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden"))
        self.network.start()
        self.addCleanup(self.network.stop)

    def generator(self, wid, flags, valid=False):
        cards = []
        for i, accepted in enumerate(flags):
            original = copy.deepcopy(self.card)
            if not accepted and not valid:
                original["evidence_spans"][0]["end"] = 999
            cards.append({"card_id": f"{wid}#{i}", "generator_card": original,
                          "accepted_for_verification": accepted,
                          "schema_errors": [] if accepted else ["span_out_of_bounds:" + self.sid],
                          **({"normalized_card": original} if accepted else {})})
        return {"window_id": wid, "chapter_id": "B001:C0001", "role": "rule_atom_read",
                "sentence_ids": [self.sid], "raw_response": json.dumps({"propositions": [c["generator_card"] for c in cards]},
                                                                        ensure_ascii=False),
                "call_meta": {"http_status": 200, "finish_reason": "stop"},
                "parse_error": None, "proposed_count": len(cards), "cards": cards}

    def put(self, path, data):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return B.digest(data)

    def freeze(self, mutate_queue=None, mutate_report=None):
        inventory = []
        hashes = {}
        for path, rows in ((self.cp, self.coverage), (self.sp, self.sentences), (self.gp, self.gens)):
            data = B.jsonl(rows)
            sha = self.put(path, data)
            hashes[path] = sha
            inventory.append({"path": path, "sha256": sha, "bytes": len(data)})
        job = {"book": self.work, "roles": ["rule_atom_read"], "input_artifact_hashes": {
            "coverage_partition.jsonl": hashes[self.cp], "sentences.jsonl": hashes[self.sp],
            "historical_prompt_not_read.txt": "0" * 64}}
        data = B.encoded(job)
        inventory.append({"path": self.jp, "sha256": self.put(self.jp, data), "bytes": len(data)})
        queue = []
        for number, row in enumerate(self.gens, 1):
            loc = {"path": self.gp, "file_sha256": hashes[self.gp], "line": number,
                   "row_sha256": B.digest(B.canonical(row)),
                   "raw_response_sha256": B.digest(row["raw_response"].encode("utf-8"))}
            if row.get("parse_error"):
                queue.append({"work": self.work, "cohort": "wave_a", "window_id": row["window_id"],
                              "card_id": None, "kind": "generator_window", "error_codes": [row["parse_error"]],
                              "attempt_artifact": loc})
            for i, card in enumerate(row["cards"]):
                if not card["accepted_for_verification"]:
                    queue.append({"work": self.work, "cohort": "wave_a", "window_id": row["window_id"],
                                  "card_id": card["card_id"], "kind": "schema_or_span_rejection",
                                  "error_codes": card["schema_errors"], "attempt_artifact": {**loc, "card_index": i}})
        if mutate_queue:
            mutate_queue(queue)
        report = {"generator_repair_queue_rows": len(queue), "historical_input_hash_checks": [
            {"work": self.work, "label": "coverage_partition.jsonl", "path": self.cp,
             "recorded_sha256": hashes[self.cp]},
            {"work": self.work, "label": "sentences.jsonl", "matching_paths": [self.sp],
             "recorded_sha256": hashes[self.sp], "pointers": [{"recorded_path": "/mnt/d/persisted/alias"}]}]}
        if mutate_report:
            mutate_report(report)
        self.pins = {}
        for name, data in (("report.json", B.encoded(report)), ("manifest.json", B.encoded({"cohorts": {"wave_a": [self.work]}})),
                           ("input_hashes.jsonl", B.jsonl(inventory)), ("generator_repair_queue.jsonl", B.jsonl(queue))):
            self.pins[name] = self.put("audit/" + name, data)

    def build(self):
        return B.Builder(self.root, self.audit, self.pins).compile()

    def rows(self, products, partition=0):
        return [json.loads(line) for line in products[B.QUEUE_FILES[partition]].splitlines()]

    def cli_args(self):
        args = ["--root", str(self.root), "--audit-dir", str(self.audit)]
        for flag, name in (("--audit-manifest-sha256", "manifest.json"), ("--repair-queue-sha256", "generator_repair_queue.jsonl"),
                           ("--input-inventory-sha256", "input_hashes.jsonl"), ("--audit-report-sha256", "report.json")):
            args += [flag, self.pins[name]]
        return args

    def test_rejected_and_good_sibling_one_window_one_call(self):
        self.freeze()
        products, report = self.build()
        row, = self.rows(products)
        self.assertEqual((row["rejected_sibling_count"], row["already_good_sibling_count"],
                          row["total_original_window_cards"]), (1, 1, 2))
        self.assertEqual(report["totals"]["max_future_8000_calls_if_explicitly_authorized"], 1)
        self.assertFalse(row["boundaries"]["dispatch_authorized"])
        self.assertNotIn(b"PRIVATE_PROPOSITION", b"".join(products.values()))
        self.assertEqual(report["model_calls"], 0)

    def test_multiple_rejected_merge(self):
        self.gens = [self.generator("W1", [False, False, True])]
        self.freeze()
        products, report = self.build()
        self.assertEqual(len(self.rows(products)), 1)
        self.assertEqual(report["totals"]["unique_rejected_cards"], 2)
        self.assertEqual(len(self.rows(products)[0]["originating_entries"]), 2)

    def test_invalid_json_window(self):
        row = self.generator("W1", [])
        row.update(raw_response="{broken", parse_error="invalid_json")
        self.gens = [row]
        self.freeze()
        products, report = self.build()
        self.assertEqual(self.rows(products)[0]["reason_codes"], ["invalid_json"])
        self.assertEqual(report["totals"]["unique_bad_generator_windows"], 1)
        self.assertEqual(report["totals"]["unique_rejected_cards"], 0)

    def test_now_valid_offline_preserves_normalization(self):
        self.gens = [self.generator("W1", [False], valid=True)]
        self.freeze()
        products, _ = self.build()
        row, = self.rows(products, 1)
        self.assertIn("normalization_mismatch_preserved", row["observations"])
        self.assertFalse(row["original_cards"][0]["original_accepted_for_verification"])
        self.assertEqual(row["max_future_8000_calls_if_explicitly_authorized"], 0)

    def test_invalid_enum_regenerates_without_remapping(self):
        self.gens[0]["cards"][0]["generator_card"]["primary_route"] = "invalid_enum"
        self.gens[0]["raw_response"] = json.dumps({"propositions": [c["generator_card"] for c in self.gens[0]["cards"]]})
        self.freeze()
        row, = self.rows(self.build()[0])
        self.assertIn("bad_primary_route", row["reason_codes"])

    def test_hard_blockers_defer_complete_window(self):
        for case in ("work", "colliding_ids", "missing_id", "missing_file", "tamper", "chapter", "job"):
            with self.subTest(case=case):
                self.sentences = [{"sentence_id": self.sid, "chapter_id": "B001:C0001", "text": "valid source"}]
                if case == "work":
                    self.sentences[0]["work_id"] = "OTHER_WORK"
                if case == "colliding_ids":
                    self.sentences.append(copy.deepcopy(self.sentences[0]))
                if case == "missing_id":
                    self.sentences = []
                if case == "chapter":
                    self.sentences[0]["chapter_id"] = "B001:C9999"
                self.freeze()
                if case == "missing_file":
                    (self.root / self.sp).unlink()
                if case == "tamper":
                    (self.root / self.sp).write_bytes(b"{}\n")
                if case == "job":
                    (self.root / self.jp).unlink()
                products, _ = self.build()
                self.assertEqual(len(self.rows(products, 2)), 1)
                self.assertEqual(len(self.rows(products)), 0)

    def test_missing_and_wrong_provenance_path(self):
        for path in ("runs/missing/sentences.jsonl", "../outside.jsonl"):
            self.freeze(mutate_report=lambda r: r["historical_input_hash_checks"][1].update(matching_paths=[path]))
            self.assertEqual(len(self.rows(self.build()[0], 2)), 1)

    def test_local_work_id_is_not_automatically_remapped(self):
        self.sentences[0]["work_id"] = "B001"
        self.freeze()
        row, = self.rows(self.build()[0], 2)
        self.assertIn("sentence_work_mismatch", row["source_blockers"])
        self.assertEqual(row["sentence_rows"][0]["original_work_id"], "B001")
        self.assertFalse(row["original_cards"][0]["current_card_validation_performed"])

    def test_invalid_sibling_source_blocks_whole_window(self):
        other = "B001:C0001:S000002"
        self.coverage[0]["attached_sentence_ids"] = [other]
        self.gens[0]["sentence_ids"].append(other)
        self.freeze()
        row, = self.rows(self.build()[0], 2)
        self.assertIn("ambiguous_or_missing_sentence_id", row["source_blockers"])
        self.assertEqual(row["already_good_sibling_count"], 1)

    def test_bad_queue_row_raw_and_card_locators_defer(self):
        for field, value in (("row_sha256", "0" * 64), ("raw_response_sha256", "0" * 64),
                             ("line", 999), ("card_index", 999)):
            self.freeze(mutate_queue=lambda q: q[0]["attempt_artifact"].update({field: value}))
            self.assertEqual(len(self.rows(self.build()[0], 2)), 1)

    def test_conflicting_generator_pins_defer_both_groups(self):
        def conflict(queue):
            row = copy.deepcopy(queue[0])
            row["attempt_artifact"]["file_sha256"] = "0" * 64
            queue.append(row)
        self.freeze(mutate_queue=conflict)
        rows = self.rows(self.build()[0], 2)
        self.assertEqual(len(rows), 2)
        self.assertTrue(all("ambiguous_window_generator_pins" in row["reason_codes"] for row in rows))

    def test_raw_card_mismatch_deferred_no_reconstruction(self):
        self.gens[0]["cards"][0]["generator_card"]["primary_route"] = "entity_profile"
        self.freeze()
        row, = self.rows(self.build()[0], 2)
        self.assertIn("raw_generator_card_mismatch", row["reason_codes"])

    def test_duplicate_strict_raw_json_is_generation_failure(self):
        self.gens = [self.generator("W1", [])]
        self.gens[0]["raw_response"] = '{"propositions":[],"propositions":[]}'
        self.gens[0]["parse_error"] = "invalid_json"
        self.freeze()
        row, = self.rows(self.build()[0])
        self.assertIn("invalid_json", row["reason_codes"])

    def test_colliding_local_ids_in_distinct_pinned_works_do_not_merge(self):
        self.freeze()
        first = {name: (self.audit / name).read_bytes() for name in self.pins}
        old_work = self.work
        self.work = "second_work"
        self.gp = self.gp.replace(old_work, self.work)
        self.jp = self.jp.replace(old_work, self.work)
        self.cp = self.cp.replace(old_work, self.work)
        self.sp = self.sp.replace(old_work, self.work)
        self.freeze()
        combined = {
            "manifest.json": B.encoded({"cohorts": {"wave_a": [old_work, self.work]}}),
            "generator_repair_queue.jsonl": first["generator_repair_queue.jsonl"] + (self.audit / "generator_repair_queue.jsonl").read_bytes(),
            "input_hashes.jsonl": first["input_hashes.jsonl"] + (self.audit / "input_hashes.jsonl").read_bytes()}
        report = json.loads(first["report.json"])
        report["generator_repair_queue_rows"] = 2
        report["historical_input_hash_checks"] += json.loads((self.audit / "report.json").read_bytes())["historical_input_hash_checks"]
        combined["report.json"] = B.encoded(report)
        for name, data in combined.items():
            self.pins[name] = self.put("audit/" + name, data)
        products, report = self.build()
        rows = self.rows(products)
        self.assertEqual(len(rows), 2)
        self.assertNotEqual(rows[0]["group_id"], rows[1]["group_id"])
        self.assertEqual(report["totals"]["unique_rejected_cards"], 2)
        self.assertEqual(report["totals"]["works"], 2)

    def test_wsl_path_translation_is_exact_not_latest_discovery(self):
        if self.root.drive:
            path = "/mnt/" + self.root.drive[0].lower() + self.root.as_posix()[2:] + "/audit"
            self.assertEqual(B.Inputs(self.root).path(path), self.audit)

    def test_original_hash_mismatch_deferred_and_observed(self):
        self.freeze()
        (self.root / self.gp).write_bytes(b"{}\n")
        products, _ = self.build()
        row, = self.rows(products, 2)
        self.assertIn("source_hash_mismatch", row["source_blockers"])
        manifest = json.loads(products["manifest.json"])
        observed = next(p for p in manifest["actual_read_inputs"] if p["path"] == (self.root / self.gp).as_posix())
        self.assertEqual(observed["sha256"], B.digest(b"{}\n"))
        self.assertNotEqual(observed["sha256"], row["artifacts"]["generator"]["sha256"])

    def test_duplicate_queue_entry_never_silent_duplication(self):
        self.freeze(mutate_queue=lambda q: q.append(copy.deepcopy(q[0])))
        products, report = self.build()
        row, = self.rows(products, 2)
        self.assertIn("duplicate_ambiguous_queue_entry", row["reason_codes"])
        self.assertEqual(report["totals"]["input_rows"], 2)
        self.assertEqual(report["totals"]["unique_rejected_cards"], 1)
        self.assertEqual(len(products["entry_accounting.jsonl"].splitlines()), 2)

    def test_partition_small_reproducible_deterministic_unicode_lf(self):
        self.gens = [self.generator("W2", [False], valid=True), self.generator("W1", [False, False, True]),
                     self.generator("W3", [])]
        self.gens[2].update(raw_response="broken", parse_error="invalid_json")
        self.coverage = [{**self.coverage[0], "window_id": row["window_id"]} for row in self.gens]
        self.freeze()
        products, report = self.build()
        self.assertEqual(products, self.build()[0])
        self.assertEqual(report["totals"]["input_rows"], 4)
        self.assertEqual(report["totals"]["unique_affected_windows"], 3)
        self.assertEqual(report["totals"]["unique_rejected_cards"], 3)
        self.assertEqual([r["window_id"] for r in self.rows(products)], ["W1", "W3"])
        for data in products.values():
            self.assertNotIn(b"\r\n", data)
            data.decode("utf-8")
        self.assertIn(self.work.encode("utf-8"), products["entry_accounting.jsonl"])

    def test_audit_tamper_hard_failure_and_no_write(self):
        self.freeze()
        (self.audit / "generator_repair_queue.jsonl").write_bytes(b"{}\n")
        with self.assertRaisesRegex(ValueError, "source_hash_mismatch"):
            self.build()

    def test_final_rehash_detects_midbuild_change(self):
        self.freeze()
        original = B.Inputs.recheck
        def changed(inputs):
            (self.root / self.sp).write_bytes(b"changed")
            return original(inputs)
        out = self.root / "out"
        with mock.patch.object(B.Inputs, "recheck", changed), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(B.main(self.cli_args() + ["--materialize", "--out-dir", str(out)]), 1)
        self.assertFalse(out.exists())

    def test_dryrun_no_writes_and_check_tampering(self):
        self.freeze()
        before = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        out = self.root / "out"
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(B.main(self.cli_args() + ["--out-dir", str(out)]), 0)
        self.assertFalse(out.exists())
        self.assertEqual(before, {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob("*") if p.is_file()})
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(B.main(self.cli_args() + ["--materialize", "--out-dir", str(out)]), 0)
        pin = B.file_hash(out / "manifest.json")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(B.main(["--check", str(out), "--manifest-sha256", pin]), 0)
        (out / "entry_accounting.jsonl").write_bytes(b"tampered\n")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(B.main(["--check", str(out), "--manifest-sha256", pin]), 1)
            self.assertEqual(B.main(["--check", str(out)]), 1)
            self.assertEqual(B.main(self.cli_args() + ["--materialize", "--out-dir", str(out)]), 1)

    def test_only_pure_core_functions_loaded(self):
        core = B.load_core(CORE_BYTES)
        self.assertNotIn("call_model", core)
        self.assertNotIn("main", core)
        self.assertNotIn("urllib", core)
        self.assertNotIn("load_profile", core)


if __name__ == "__main__":
    unittest.main()
