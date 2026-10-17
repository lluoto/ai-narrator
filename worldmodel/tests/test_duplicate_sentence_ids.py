"""Offline synthetic regressions; no production runner, models or network."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


PATH = Path(__file__).resolve().parents[1] / "tools/audit_duplicate_sentence_ids.py"
SPEC = importlib.util.spec_from_file_location("duplicate_sentence_id_audit", PATH)
A = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(A)


class DuplicateAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.work = "fixture_work"
        self.source = self.root / "runs" / self.work / "snapshot.jsonl"
        self.source.parent.mkdir(parents=True)
        self.base = {"sentence_id": "B001:C1:S1", "text": "PRIVATE_SOURCE", "exact_text": "PRIVATE_SOURCE",
                     "work_id": "B001", "chapter_id": "B001:C1", "source_char_start": 10,
                     "source_char_end": 24, "line_number": 3, "source_hash": None}

    def scan(self, rows):
        data = rows if isinstance(rows, bytes) else A.jsonl(rows)
        self.source.write_bytes(data)
        inputs = A.Inputs(self.root)
        ref = {"path": self.source.as_posix(), "sha256": A.digest(data)}
        first, dup, malformed, counts = A.scan_source(inputs, ref)
        groups = {sid: A.classify_group(self.work, ref, sid, items) for sid, items in dup.items()}
        return first, dup, malformed, counts, groups

    def test_byte_identical_multiplicity_and_proposal_preserves_every_line(self):
        _, dup, _, counts, groups = self.scan([self.base] * 3)
        group = groups[self.base["sentence_id"]]
        self.assertEqual(group["category"], "byte_identical_rows")
        self.assertEqual(counts["valid_sentence_rows"], 3)
        self.assertEqual(len(dup[self.base["sentence_id"]]), 3)
        proposal = group["proposed_mapping_sidecar"]
        self.assertEqual([r["line"] for r in proposal["all_original_line_refs"]], [1, 2, 3])
        self.assertEqual(proposal["multiplicity"], 3)
        self.assertTrue(proposal["proposal_only"])
        self.assertFalse(proposal["survivor_selected"])

    def test_json_key_order_is_not_byte_identical(self):
        raw = A.canonical(self.base) + b"\n" + json.dumps(dict(reversed(list(self.base.items())))).encode() + b"\n"
        group = self.scan(raw)[4][self.base["sentence_id"]]
        self.assertEqual(group["category"], "json_semantically_identical_rows")
        self.assertEqual(group["differing_fields"], [])
        self.assertNotIn("proposed_mapping_sidecar", group)

    def test_identical_text_different_offsets_or_provenance_is_conflict(self):
        for field, value in (("source_char_start", 99), ("line_number", 4), ("source_hash", "different"),
                             ("extra_provenance", {"nested": [2]}), ("chapter_id", "B001:C2")):
            with self.subTest(field=field):
                group = self.scan([self.base, {**self.base, field: value}])[4][self.base["sentence_id"]]
                self.assertEqual(group["category"], "conflicting_rows")
                self.assertTrue(group["comparison_dimensions"]["text"]["equal"])
                self.assertEqual(group["differing_fields"], [field])
                self.assertNotIn("proposed_mapping_sidecar", group)

    def test_differing_text_is_conflict(self):
        group = self.scan([self.base, {**self.base, "text": "PRIVATE_OTHER"}])[4][self.base["sentence_id"]]
        self.assertEqual(group["category"], "conflicting_rows")
        self.assertFalse(group["comparison_dimensions"]["text"]["equal"])
        self.assertNotIn(b"PRIVATE_", A.jsonl([group]))

    def test_work_collision_not_merged_or_remapped(self):
        group = self.scan([self.base, {**self.base, "work_id": "OTHER_WORK"}])[4][self.base["sentence_id"]]
        self.assertEqual(group["category"], "conflicting_rows")
        self.assertTrue(group["cross_record_work_value_collision"])
        self.assertEqual(group["work_scope"], self.work)
        self.assertNotIn(b"OTHER_WORK", A.canonical(group))
        source = {"path": "other/snapshot.jsonl", "sha256": "a" * 64}
        other = A.classify_group("other_scope", source, self.base["sentence_id"],
                                 self.scan([self.base] * 2)[1][self.base["sentence_id"]])
        self.assertNotEqual(group["group_sha256"], other["group_sha256"])

    def test_raw_slice_mutation_between_occurrences_fails(self):
        self.source.write_bytes(A.jsonl([self.base] * 2))
        original = A.parse_source
        calls = 0
        def changed(raw):
            nonlocal calls
            calls += 1
            if calls == 2:
                with self.source.open("r+b") as handle:
                    handle.write(b"X")
            return original(raw)
        ref = {"path": str(self.source), "sha256": A.digest(self.source.read_bytes())}
        with mock.patch.object(A, "parse_source", changed):
            with self.assertRaisesRegex(ValueError, "source_slice_changed|input_changed_during_scan"):
                A.scan_source(A.Inputs(self.root), ref)

    def test_lf_crlf_and_missing_final_newline(self):
        raw = A.canonical(self.base)
        data = raw + b"\n" + raw + b"\r\n" + raw
        _, duplicates, _, counts, groups = self.scan(data)
        self.assertEqual(counts["physical_lf_rows"], 3)
        self.assertEqual(groups[self.base["sentence_id"]]["category"], "json_semantically_identical_rows")
        locs = [loc for _, loc in duplicates[self.base["sentence_id"]]]
        self.assertEqual([r["terminator"] for r in locs], ["LF", "CRLF", "none"])
        self.assertEqual(len({r["row_sha256"] for r in locs}), 1)
        self.assertEqual([r["byte_offset"] for r in locs], [0, len(raw) + 1, 2 * len(raw) + 3])
        for loc in locs:
            sliced = data[loc["byte_offset"]:loc["byte_offset"] + loc["byte_length"]]
            self.assertEqual(A.digest(sliced), loc["raw_lf_row_sha256"])

    def test_literal_utf8_separators_and_escaped_encoding(self):
        row = {**self.base, "text": "PRIVATE\u2028MID\u2029END\u0085FINAL\nESCAPED"}
        raw = json.dumps(row, ensure_ascii=False).encode("utf-8")
        data = raw + b"\r\n" + A.canonical(row) + b"\n"
        _, _, malformed, counts, groups = self.scan(data)
        self.assertEqual(counts["physical_lf_rows"], 2)
        self.assertEqual(malformed, [])
        self.assertEqual(groups[row["sentence_id"]]["category"], "json_semantically_identical_rows")
        indexed = list(A.records(data))
        self.assertEqual(len(indexed), 2)
        self.assertEqual(indexed[1][1]["byte_offset"], len(raw) + 2)
        self.assertEqual(indexed[0][0], indexed[1][0])

    def test_malformed_rows_and_malformed_id_group(self):
        malformed = {**self.base, "text": None}
        data = A.jsonl([self.base, malformed]) + b'{not json}\n[]\n\n'
        _, _, errors, counts, groups = self.scan(data)
        self.assertEqual(groups[self.base["sentence_id"]]["category"], "malformed")
        self.assertEqual(counts["malformed_rows"], 3)
        self.assertEqual(counts["blank_rows"], 1)
        self.assertEqual(len(errors), 3)
        self.assertNotIn(b"PRIVATE_SOURCE", A.canonical(groups))

    def test_duplicate_json_keys_never_select_first_or_last_id(self):
        data = b'{"sentence_id":"one","sentence_id":"two","text":"PRIVATE"}\n'
        first, duplicates, errors, _, _ = self.scan(data)
        self.assertEqual(first, {})
        self.assertEqual(duplicates, {})
        self.assertIsNone(errors[0]["sentence_id_sha256"])
        data = A.jsonl([self.base]) + b'{"sentence_id":"B001:C1:S1","text":"a","text":"b"}\n'
        self.assertEqual(self.scan(data)[4][self.base["sentence_id"]]["category"], "malformed")

    def test_exact_canonical_types_not_python_bool_number_equality(self):
        group = self.scan([{**self.base, "flag": True}, {**self.base, "flag": 1}])[4][self.base["sentence_id"]]
        self.assertEqual(group["category"], "conflicting_rows")

    def test_all_groups_including_unaffected_and_singleton_raw_not_retained(self):
        other = {**self.base, "sentence_id": "unaffected"}
        single = {**self.base, "sentence_id": "singleton"}
        first, duplicates, _, counts, groups = self.scan([self.base, other, single, self.base, other])
        self.assertEqual(counts["distinct_sentence_ids"], 3)
        self.assertEqual(set(duplicates), {self.base["sentence_id"], "unaffected"})
        self.assertTrue(all(isinstance(v, dict) for v in first.values()))
        self.assertEqual(A.duplicate_counts(list(groups.values()))["duplicate_id_groups"], 2)
        self.assertEqual(A.duplicate_counts(list(groups.values()))["rows_in_duplicate_groups"], 4)

    def test_wrong_source_hash_fails(self):
        self.source.write_bytes(A.jsonl([self.base] * 2))
        with self.assertRaisesRegex(ValueError, "source_hash_mismatch"):
            A.scan_source(A.Inputs(self.root), {"path": str(self.source), "sha256": "0" * 64})

    def freeze(self, mutate=None):
        """A complete independently pinned miniature upstream chain."""
        self.source.write_bytes(A.jsonl([self.base, self.base, {**self.base, "sentence_id": "unaffected"},
                                        {**self.base, "sentence_id": "unaffected"}]))
        self.invdir = self.root / "sealed_inventory"
        self.invdir.mkdir(exist_ok=True)
        audit = self.root / "upstream"
        audit.mkdir(exist_ok=True)

        def put(path, data):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            return {"path": path.as_posix(), "sha256": A.digest(data), "bytes": len(data)}

        source_ref = {"path": self.source.as_posix(), "sha256": A.digest(self.source.read_bytes())}
        cov = {"window_id": "W1", "chapter_id": "B001:C1", "work_id": self.work, "role": "read",
               "anchor_sentence_ids": [self.base["sentence_id"]], "attached_sentence_ids": []}
        gen = {"window_id": "W1", "chapter_id": "B001:C1", "work_id": self.work, "role": "read",
               "sentence_ids": [self.base["sentence_id"]], "raw_response": "PRIVATE_RESPONSE"}
        cov_ref = put(self.root / "coverage.jsonl", A.jsonl([cov]))
        gen_ref = put(self.root / "generation.jsonl", A.jsonl([gen]))
        job = {"book": self.work, "roles": ["read"], "input_artifact_hashes": {
               "sentences.jsonl": source_ref["sha256"], "coverage_partition.jsonl": cov_ref["sha256"]}}
        job_ref = put(self.root / "job.json", A.encoded(job))
        refs = {name: {k: r[k] for k in ("path", "sha256")} for name, r in
                (("coverage", cov_ref), ("generator", gen_ref), ("job", job_ref), ("sentences", source_ref))}
        inputs = [cov_ref, gen_ref, job_ref, {**source_ref, "bytes": self.source.stat().st_size}]
        pins = {}
        pins["input_hashes.jsonl"] = put(audit / "input_hashes.jsonl", A.jsonl(inputs))["sha256"]
        historical = [{"work": self.work, "label": label, "recorded_sha256": ref["sha256"],
                       "path": ref["path"], "matching_paths": [ref["path"]]} for label, ref in
                      (("coverage_partition.jsonl", cov_ref), ("sentences.jsonl", source_ref))]
        pins["report.json"] = put(audit / "report.json", A.encoded({"historical_input_hash_checks": historical}))["sha256"]
        pins["generator_repair_queue.jsonl"] = put(audit / "generator_repair_queue.jsonl", b"")["sha256"]
        pins["manifest.json"] = put(audit / "manifest.json", A.encoded({"products": list(pins)}))["sha256"]
        source_locs = []
        for line, raw in enumerate(self.source.read_bytes().split(b"\n")[:2], 1):
            source_locs.append({"sentence_id": self.base["sentence_id"], "line": line, "row_sha256": A.digest(raw),
                                "path": self.source.as_posix(), "file_sha256": source_ref["sha256"]})
        def rowloc(ref, row):
            return {"line": 1, "row_sha256": A.digest(A.canonical(row)), "path": ref["path"], "file_sha256": ref["sha256"]}
        entry = {"work_id": self.work, "window_id": "W1", "chapter_id": "B001:C1", "group_id": "sealed_group",
                 "decision": "deferred_source_or_policy", "artifacts": refs,
                 "source_blockers": ["sentence_id_ambiguous", "sentence_work_mismatch"],
                 "audited_sentence_aliases": [source_ref], "original_execution_input_pins": job["input_artifact_hashes"],
                 "sentence_ids": gen["sentence_ids"], "sentence_rows": source_locs,
                 "coverage_row": rowloc(cov_ref, cov), "generator_rows": [rowloc(gen_ref, gen)],
                 "raw_response_sha256": A.digest(gen["raw_response"].encode())}
        if mutate:
            mutate(entry)
        outputs = {}
        for name, data in (("deferred_windows.jsonl", A.jsonl([entry])),
                           ("report.json", A.encoded({"by_reason": {"sentence_id_ambiguous": {"windows": 1}}}))):
            outputs[name] = put(self.invdir / name, data)
        manifest = {"outputs": outputs, "audit_dir": str(audit), "audit_pins": pins, "actual_read_inputs": inputs}
        self.invpin = put(self.invdir / "manifest.json", A.encoded(manifest))["sha256"]
        self.entry, self.refs = entry, refs

    def build(self):
        return A.build(self.root, self.invdir, self.invpin, self.work, 1)

    def test_full_binding_deterministic_no_mutation_no_prose_and_unaffected_counts(self):
        self.freeze()
        before = {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        products, report = self.build()
        self.assertEqual(products, self.build()[0])
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()})
        self.assertEqual(report["whole_file_duplicates"]["duplicate_id_groups"], 2)
        self.assertEqual(report["affected_window_duplicates"]["duplicate_id_groups"], 1)
        self.assertEqual(report["duplicates_not_referenced_by_affected_windows"]["duplicate_id_groups"], 1)
        self.assertEqual(report["window_category_partition"]["byte_identical_rows"], 1)
        self.assertNotIn(b"PRIVATE_", b"".join(products.values()))
        manifest = json.loads(products["manifest.json"])
        self.assertEqual(manifest["script"]["sha256"], A.digest(PATH.read_bytes()))
        for name, pin in manifest["outputs"].items():
            self.assertEqual(pin["sha256"], A.digest(products[name]))
        window = json.loads(products["affected_windows.jsonl"])
        self.assertEqual(window["matching_source_id_groups"][0]["multiplicity"], 2)

    def test_pinned_but_bad_window_joins_rejected(self):
        mutations = [("window_row_pin_mismatch", lambda e: e["coverage_row"].update(row_sha256="0" * 64)),
                     ("window_sentence_ids_mismatch", lambda e: e.update(sentence_ids=["wrong"])),
                     ("sentence_row_binding_mismatch", lambda e: e["sentence_rows"].pop()),
                     ("raw_response_pin_mismatch", lambda e: e.update(raw_response_sha256="0" * 64)),
                     ("row_path_mismatch", lambda e: e["coverage_row"].update(path="other")),
                     ("original_execution_pin_mismatch", lambda e: e["original_execution_input_pins"].update(**{"sentences.jsonl": "0" * 64}))]
        for reason, mutate in mutations:
            with self.subTest(reason=reason):
                self.freeze(mutate)
                with self.assertRaisesRegex(ValueError, reason):
                    self.build()

    def test_wrong_inventory_upstream_and_job_pins_fail_closed(self):
        self.freeze()
        with self.assertRaisesRegex(ValueError, "input_hash_mismatch"):
            A.build(self.root, self.invdir, "0" * 64, self.work, 1)
        for path in (self.root / "upstream/input_hashes.jsonl", self.root / "job.json"):
            original = path.read_bytes()
            path.write_bytes(original + b" ")
            with self.assertRaisesRegex(ValueError, "input_hash_mismatch"):
                self.build()
            path.write_bytes(original)

    def test_window_work_collision_fails_without_metadata_mapping(self):
        self.freeze(lambda e: e.update(work_id="OTHER_WORK"))
        with self.assertRaisesRegex(ValueError, "unexpected_ambiguous_work_scope"):
            self.build()

    def test_pinned_upstream_inventory_conflicting_artifact_pin_rejected(self):
        self.freeze()
        path = self.root / "upstream/input_hashes.jsonl"
        rows = [row for row, _ in A.records(path.read_bytes())]
        rows[0]["sha256"] = "0" * 64
        path.write_bytes(A.jsonl(rows))
        manifest_path = self.invdir / "manifest.json"
        manifest = json.loads(manifest_path.read_bytes())
        manifest["audit_pins"]["input_hashes.jsonl"] = A.digest(path.read_bytes())
        manifest_path.write_bytes(A.encoded(manifest))
        self.invpin = A.digest(manifest_path.read_bytes())
        with self.assertRaisesRegex(ValueError, "upstream_inventory_pin_mismatch"):
            self.build()

    def test_mixed_group_window_partition_is_conservative(self):
        self.freeze()
        inputs = A.Inputs(self.root)
        first, duplicates, _, _ = A.scan_source(inputs, self.refs["sentences"])
        sid = self.base["sentence_id"]
        groups = {sid: A.classify_group(self.work, self.refs["sentences"], sid, duplicates[sid])}
        cov = list(A.records((self.root / "coverage.jsonl").read_bytes()))[0]
        gen = list(A.records((self.root / "generation.jsonl").read_bytes()))[0]
        cov = (cov[0], {**cov[1], "file_sha256": self.refs["coverage"]["sha256"]})
        gen = (gen[0], {**gen[1], "file_sha256": self.refs["generator"]["sha256"]})
        other = "unaffected"
        cov[0]["attached_sentence_ids"] = [other]
        gen[0]["sentence_ids"].append(other)
        self.entry["sentence_ids"] = gen[0]["sentence_ids"]
        for _, loc in duplicates[other]:
            self.entry["sentence_rows"].append({**loc, "sentence_id": other,
                "file_sha256": self.refs["sentences"]["sha256"]})
        groups[other] = A.classify_group(self.work, self.refs["sentences"], other, duplicates[other])
        groups[other]["category"] = "conflicting_rows"
        result = A.join_window(self.entry, {}, cov, gen, self.refs["sentences"], first, duplicates, groups)
        self.assertEqual(result["category"], "conflicting_rows")
        self.assertEqual({g["category"] for g in result["matching_source_id_groups"]},
                         {"byte_identical_rows", "conflicting_rows"})

    def test_path_escape_and_unowned_materialization_rejected(self):
        with self.assertRaisesRegex(ValueError, "unsafe_path"):
            A.Inputs(self.root).path("runs/../source.jsonl")
        self.freeze()
        out = self.root / A.OUT
        out.parent.mkdir(parents=True)
        args = ["--root", str(self.root), "--materialize", "--out-dir", str(out.with_name("not_owned"))]
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(A.main(args), 1)
        self.assertFalse(out.with_name("not_owned").exists())

    def test_slice_rereads_only_duplicate_first_rows_no_second_full_scan(self):
        self.freeze()
        original = Path.open
        opens = []
        def observed(path, *args, **kwargs):
            if path == self.source:
                opens.append(args)
            return original(path, *args, **kwargs)
        with mock.patch.object(Path, "open", observed):
            self.build()
        self.assertEqual(opens, [("rb",)])

    def test_change_after_scan_detected_without_rescan(self):
        self.scan([self.base] * 2)
        inputs = A.Inputs(self.root)
        ref = {"path": str(self.source), "sha256": A.digest(self.source.read_bytes())}
        A.scan_source(inputs, ref)
        self.source.write_bytes(b"different")
        with self.assertRaisesRegex(ValueError, "input_changed_during_audit"):
            inputs.recheck()

    def test_safe_line_slicing_records_crlf_final_no_newline(self):
        raw = b'{"one":1}\r\n\n{"two":2}'
        rows = list(A.records(raw))
        self.assertEqual([loc["line"] for _, loc in rows], [1, 3])
        for _, loc in rows:
            sliced = raw[loc["byte_offset"]:loc["byte_offset"] + loc["byte_length"]]
            self.assertEqual(A.digest(sliced), loc["raw_lf_row_sha256"])
        self.assertEqual(rows[-1][1]["terminator"], "none")

    def test_cli_dryrun_materialize_absent_only_check_readonly_and_tamper(self):
        self.freeze()
        out = self.root / A.OUT
        out.parent.mkdir(parents=True)
        real_build = A.build
        def fixture_build(root, invdir, pin):
            return real_build(root, invdir, pin, self.work, 1)
        args = ["--root", str(self.root), "--inventory-dir", str(self.invdir),
                "--inventory-manifest-sha256", self.invpin]
        with mock.patch.object(A, "build", fixture_build), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(A.main(args), 0)
            self.assertFalse(out.exists())
            self.assertEqual(A.main(args + ["--materialize"]), 0)
            self.assertEqual(A.main(args + ["--materialize"]), 1)
            pin = A.digest((out / "manifest.json").read_bytes())
            before = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.root.rglob("*") if p.is_file()}
            self.assertEqual(A.main(args + ["--check", str(out)]), 1)
            self.assertEqual(A.main(args + ["--check", str(out), "--manifest-sha256", pin]), 0)
            self.assertEqual(before, {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.root.rglob("*") if p.is_file()})
            (out / "groups.jsonl").write_bytes(b"tampered")
            self.assertEqual(A.main(args + ["--check", str(out), "--manifest-sha256", pin]), 1)


if __name__ == "__main__":
    unittest.main()
