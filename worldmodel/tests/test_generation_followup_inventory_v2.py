"""V2 regressions plus the inherited v1 offline suite; v1 files are not edited."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest import mock

import test_generation_followup_inventory as fixture


PATH = Path(__file__).resolve().parents[1] / "tools/build_generation_followup_inventory_v2.py"
SPEC = importlib.util.spec_from_file_location("generation_followup_inventory_v2", PATH)
B = importlib.util.module_from_spec(SPEC)
exec(compile(PATH.read_bytes(), str(PATH), "exec"), B.__dict__)
V1_BYTES = fixture.PATH.read_bytes()


class InventoryV2Tests(fixture.InventoryTests):
    def setUp(self):
        # Reuse the safe temp fixture and all base assertions against v2, not v1.
        patch = mock.patch.object(fixture, "B", B)
        patch.start()
        self.addCleanup(patch.stop)
        patch = mock.patch.object(fixture, "PATH", PATH)
        patch.start()
        self.addCleanup(patch.stop)
        super().setUp()
        prior_dir = self.root / "sealed_v1"
        prior_dir.mkdir()
        tool = self.root / "sealed_v1_tool.py"
        tool.write_bytes(V1_BYTES)
        report_data = B.encoded({"totals": {}, "partitions": {}, "by_reason": {}})
        (prior_dir / "report.json").write_bytes(report_data)
        manifest_data = B.encoded({"builder": {"path": tool.as_posix(), "sha256": B.digest(V1_BYTES)},
                                   "outputs": {"report.json": {"sha256": B.digest(report_data)}}})
        (prior_dir / "manifest.json").write_bytes(manifest_data)
        self.prior = {"tool": {"path": tool.as_posix(), "sha256": B.digest(V1_BYTES)},
                      "manifest": {"path": (prior_dir / "manifest.json").as_posix(),
                                   "sha256": B.digest(manifest_data)}}

    def build(self):
        return B.Builder(self.root, self.audit, self.pins, self.prior).compile()

    def cli_args(self):
        return super().cli_args() + ["--v1-tool", self.prior["tool"]["path"],
                                    "--v1-tool-sha256", self.prior["tool"]["sha256"],
                                    "--v1-manifest", self.prior["manifest"]["path"],
                                    "--v1-manifest-sha256", self.prior["manifest"]["sha256"]]

    def pinned_job(self, value):
        data = B.encoded(value)
        pin = self.put(self.jp, data)
        inventory = [json.loads(raw) for raw in (self.audit / "input_hashes.jsonl").read_bytes().splitlines()]
        for entry in inventory:
            if entry["path"] == self.jp:
                entry.update(sha256=pin, bytes=len(data))
        self.pins["input_hashes.jsonl"] = self.put("audit/input_hashes.jsonl", B.jsonl(inventory))

    def test_extra_generation_top_key_regenerates_not_offline(self):
        self.gens = [self.generator("W1", [False], valid=True)]
        payload = json.loads(self.gens[0]["raw_response"])
        payload["extra"] = "PRIVATE_EXTRA_RESPONSE"
        self.gens[0]["raw_response"] = json.dumps(payload)
        self.freeze()
        products, report = self.build()
        row, = self.rows(products)
        self.assertEqual(row["reason_codes"], ["generation_envelope_keys_invalid"])
        self.assertEqual(self.rows(products, 1), [])
        self.assertEqual(report["by_reason"]["generation_envelope_keys_invalid"]["windows"], 1)
        self.assertNotIn(b"PRIVATE_EXTRA_RESPONSE", b"".join(products.values()))

    def test_extra_generation_key_on_empty_window_regenerates(self):
        self.gens = [self.generator("W1", [])]
        self.gens[0].update(raw_response='{"propositions":[],"extra":true}', parse_error="generator_schema")
        self.freeze()
        row, = self.rows(self.build()[0])
        self.assertEqual(row["reason_codes"], ["generation_envelope_keys_invalid"])

    def test_pinned_malformed_job_shapes_defer_without_attribute_error(self):
        self.freeze()
        valid_job = json.loads((self.root / self.jp).read_bytes())
        cases = [[], None, "job", {**valid_job, "input_artifact_hashes": []},
                 {**valid_job, "input_artifact_hashes": None},
                 {**valid_job, "roles": "rule_atom_read"}, {**valid_job, "roles": None},
                 {**valid_job, "roles": [17]}]
        for job in cases:
            with self.subTest(job=job):
                self.pinned_job(job)
                products, report = self.build()
                row, = self.rows(products, 2)
                self.assertIn("job_shape_invalid", row["reason_codes"])
                self.assertEqual(self.rows(products), [])
                self.assertEqual(report["by_reason"]["job_shape_invalid"]["windows"], 1)

    def test_pinned_list_job_materializes_controlled_deferral(self):
        self.freeze()
        self.pinned_job([])
        out = self.root / "job_shape_output"
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(B.main(self.cli_args() + ["--materialize", "--out-dir", str(out)]), 0)
        row, = [json.loads(raw) for raw in (out / "deferred_windows.jsonl").read_bytes().splitlines()]
        self.assertIn("job_shape_invalid", row["reason_codes"])

    def test_duplicate_sentence_and_conflicting_work_both_reported(self):
        original = copy.deepcopy(self.sentences[0])
        conflict = {**original, "work_id": "B001"}
        for sources in ([original, conflict], [conflict, original]):
            self.sentences = sources
            self.freeze()
            products, report = self.build()
            row, = self.rows(products, 2)
            self.assertEqual(row["source_blockers"], ["sentence_id_ambiguous", "sentence_work_mismatch"])
            self.assertEqual(len(row["sentence_rows"]), 2)
            self.assertEqual({r["line"] for r in row["sentence_rows"]}, {1, 2})
            self.assertEqual({r["original_work_id"] for r in row["sentence_rows"]}, {None, "B001"})
            self.assertEqual(report["source_blocker_overlap"]["ambiguous_and_work_mismatch_windows"], 1)
            self.assertEqual(report["by_reason"]["sentence_id_missing"]["windows"], 0)

    def test_duplicate_sentence_without_work_conflict_still_deferred(self):
        self.sentences.append(copy.deepcopy(self.sentences[0]))
        self.freeze()
        row, = self.rows(self.build()[0], 2)
        self.assertEqual(row["source_blockers"], ["sentence_id_ambiguous"])
        self.assertEqual(len(row["sentence_rows"]), 2)

    def test_invalid_sibling_source_blocks_whole_window(self):
        # The inherited v1 assertion used its deliberately frozen combined diagnostic.
        other = "B001:C0001:S000002"
        self.coverage[0]["attached_sentence_ids"] = [other]
        self.gens[0]["sentence_ids"].append(other)
        self.freeze()
        products, report = self.build()
        row, = self.rows(products, 2)
        self.assertEqual(row["source_blockers"], ["sentence_id_missing"])
        self.assertEqual(row["already_good_sibling_count"], 1)
        self.assertEqual(report["by_reason"]["sentence_id_ambiguous"]["windows"], 0)

    def test_supersession_pins_read_and_rehashed_without_writes(self):
        self.freeze()
        before = {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        products, report = self.build()
        self.assertEqual(report["schema_version"], 2)
        self.assertEqual(report["supersession"]["v1_tool"], self.prior["tool"])
        self.assertEqual(report["supersession"]["v1_manifest"], self.prior["manifest"])
        manifest = json.loads(products["manifest.json"])
        read_paths = {r["path"] for r in manifest["actual_read_inputs"]}
        self.assertIn(self.prior["tool"]["path"], read_paths)
        self.assertIn(self.prior["manifest"]["path"], read_paths)
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()})
        Path(self.prior["tool"]["path"]).write_bytes(b"changed v1")
        with self.assertRaisesRegex(ValueError, "source_hash_mismatch"):
            self.build()


if __name__ == "__main__":
    unittest.main()
