"""Offline exact-scope authorization tests; no application or model imports."""
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


SPEC = importlib.util.spec_from_file_location(
    "approved_source_identity", Path(__file__).resolve().parents[1] / "tools/approved_source_identity.py")
identity = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(identity)


class ApprovedIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="approved_identity_")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.ns = self.root / "namespace/manifest.json"
        self.gen = self.root / "inventory/manifest.json"
        self.out = self.root / "approved"
        self.patches = [mock.patch.object(identity, "ROOT", self.root),
                        mock.patch.object(identity, "OUT", self.out)]
        for patch in self.patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.make_inputs()
        for name, value in (("NAMESPACE_SHA256", identity.sha(self.ns.read_bytes())),
                            ("INVENTORY_SHA256", identity.sha(self.gen.read_bytes()))):
            patch = mock.patch.object(identity, name, value)
            patch.start()
            self.addCleanup(patch.stop)

    def write(self, path, value, *, raw=False):
        path.parent.mkdir(parents=True, exist_ok=True)
        data = value if raw else identity.encoded(value)
        path.write_bytes(data)
        return {"path": path.as_posix(), "sha256": identity.sha(data), "bytes": len(data)}

    def make_inputs(self):
        gen_report = self.write(self.gen.parent / "report.json", {"offline": True})
        gen_manifest = {"outputs": {"report.json": {k: gen_report[k] for k in ("sha256", "bytes")}}}
        inventory_ref = self.write(self.gen, gen_manifest)
        inventory_short = {k: inventory_ref[k] for k in ("path", "sha256")}
        self.evidence, proposals, metadata_works, pins = [], [], [], []
        self.originals = {}
        for i in range(84):
            work = f"Title-{i:03d}" if i != 83 else identity.EXCLUDED_WORK
            directory = self.root / "sources" / work
            row = {"work_id": "B001", "sentence_id": "B001:C001:S001", "text": f"PRIVATE_PROSE_{i}"}
            source = self.write(directory / "sentences.jsonl", identity.encoded(row).replace(b"\n", b"") + b"\n", raw=True)
            self.originals[source["path"]] = Path(source["path"]).read_bytes()
            coverage = self.write(directory / "coverage.jsonl", b"{}\n", raw=True)
            generator = self.write(directory / "generator.jsonl", b"{}\n", raw=True)
            job = self.write(directory / "job.json", {"book": work})
            chapter = self.write(directory / "chapters.json", {"chapter_id": "B001:C001"})
            pins.extend([source, coverage, generator, job, chapter])
            short = lambda pin: {k: pin[k] for k in ("path", "sha256")}
            artifacts = {"sentences": short(source), "coverage": short(coverage),
                         "generator": short(generator), "job": short(job)}
            status = "unresolved" if i == 83 else "mapping_candidate_needs_approval"
            windows = 47 if i == 83 else 2104 if i == 0 else 1
            proposal = {"key": {"work_id": work, "source_sha256": source["sha256"], "local_work_id": "B001"},
                        "target_work_id": work, "status": status, "approved": False, "applied": False,
                        "global_alias": False, "source_row_count": 1, "source_line_ranges": [[1, 1]],
                        "selected_row_count": 1, "evidence_file": "per_work_bindings.jsonl",
                        "lineage_fully_confirmed": False}
            item = {"work_id": work, "status": status, "artifacts": artifacts,
                    "proposed_bindings": [proposal], "conflicts": [], "deferred_window_count": windows,
                    "metadata_refs": [chapter], "lineage_fully_confirmed": False,
                    "declared_metadata_namespace_relation": "no_explicit_code_title_relationship_in_pinned_metadata",
                    "sentence_distribution": {"observed_work_id_frequencies": {"B001": 1}}}
            proposals.append(proposal)
            self.evidence.append(item)
            metadata_works.append({"work_id": work, "source": short(source), "metadata": [chapter]})
        output_values = {
            "per_work_bindings.jsonl": b"".join(json.dumps(e, sort_keys=True).encode("ascii") + b"\n" for e in self.evidence),
            "mapping_proposals.json": identity.encoded({"proposal_only": True, "bindings": proposals}),
            "metadata_inventory.json": identity.encoded({"works": metadata_works}),
            "report.json": identity.encoded({"counts": {
                "mapping_candidate_needs_approval": {"works": 83, "windows": 2186},
                "unresolved": {"works": 1, "windows": 47},
                "conflicting_identity": {"works": 0, "windows": 0},
                "supported_local_namespace_mapping": {"works": 0, "windows": 0}}}),
            "report.md": b"Offline fixture\n",
        }
        refs = {name: self.write(self.ns.parent / name, data, raw=True) for name, data in output_values.items()}
        self.write(self.ns, {"version": "source_namespace_binding_audit_v2.0", "inventory": inventory_short,
                             "metadata_inventory": refs["metadata_inventory.json"], "inputs": pins,
                             "outputs": {name: {k: ref[k] for k in ("sha256", "bytes")} for name, ref in refs.items()}})

    def build(self, **kwargs):
        return identity.build(self.ns, self.gen, **kwargs)

    def materialize(self):
        outputs, records, inputs = self.build()
        identity.materialize(self.out, outputs, inputs)
        return identity.sha(outputs["manifest.json"]), records

    def load(self, pin=None, **kwargs):
        if pin is None:
            pin = identity.sha((self.out / "manifest.json").read_bytes())
        return identity.load_approved_bindings(self.out / "manifest.json", pin, **kwargs)

    def reseal_output(self, name, data):
        (self.out / name).write_bytes(data)
        manifest = identity.strict((self.out / "manifest.json").read_bytes())
        manifest["outputs"][name] = {"sha256": identity.sha(data), "bytes": len(data)}
        if name == "authorization.json":
            manifest["authorization"] = {"path": name, **manifest["outputs"][name]}
        (self.out / "manifest.json").write_bytes(identity.encoded(manifest))
        return identity.sha((self.out / "manifest.json").read_bytes())

    def test_colliding_B001_exact_titles_and_full_hashes(self):
        pin, records = self.materialize()
        bindings = self.load(pin)
        self.assertEqual(len(bindings), 83)
        self.assertEqual(sum(r["covered_deferred_window_count"] for r in records), 2186)
        first, second = records[:2]
        for record in (first, second):
            key = record["key"]
            self.assertTrue(identity.validate_local_identity(bindings, work_id=key["named_work_id"],
                source_sha256=key["full_original_sentence_file_sha256"], local_work_id="B001"))
        self.assertNotEqual(first["source"]["sha256"], second["source"]["sha256"])
        invalid = [(first["key"]["named_work_id"], second["source"]["sha256"], "B001"),
                   ("unknown", first["source"]["sha256"], "B001"),
                   (first["key"]["named_work_id"].lower(), first["source"]["sha256"], "B001"),
                   (first["key"]["named_work_id"], "f" * 64, "B001"),
                   (first["key"]["named_work_id"], first["source"]["sha256"], "B002"),
                   (identity.EXCLUDED_WORK, self.evidence[-1]["artifacts"]["sentences"]["sha256"], "B001")]
        for work, source, local in invalid:
            with self.subTest(work=work, local=local), self.assertRaises(ValueError):
                identity.validate_local_identity(bindings, work_id=work, source_sha256=source, local_work_id=local)

    def test_deep_immutability_and_pure_no_source_mutation(self):
        pin, _ = self.materialize()
        bindings = self.load(pin)
        key = next(iter(bindings))
        record = bindings[key]
        with self.assertRaises(TypeError):
            bindings[key] = {}
        with self.assertRaises(TypeError):
            record["key"]["local_work_id"] = "changed"
        with self.assertRaises(TypeError):
            record["source_line_ranges"][0][0] = 99
        with self.assertRaises(TypeError):
            record["namespace_evidence"]["metadata_refs"][0]["sha256"] = "x"
        original_row = identity.strict(self.originals[record["source"]["path"]])
        before = copy.deepcopy(original_row)
        with mock.patch.object(Path, "open", side_effect=AssertionError("pure helper must not read files")):
            self.assertTrue(identity.validate_local_identity(bindings, work_id=key[0], source_sha256=key[1], local_work_id=key[2]))
        self.assertEqual(original_row, before)
        self.assertEqual(original_row["work_id"], "B001")

    def test_approval_authority_and_unresolved_exclusion(self):
        pin, _ = self.materialize()
        bindings = self.load(pin)
        auth = identity.strict((self.out / "authorization.json").read_bytes())
        self.assertEqual(auth["counts"], identity.COUNTS)
        self.assertEqual(auth["excluded"][0]["named_work_id"], identity.EXCLUDED_WORK)
        self.assertNotIn(identity.EXCLUDED_WORK, {key[0] for key in bindings})
        for record in bindings.values():
            for key, value in identity.APPROVAL.items():
                self.assertEqual(record[key], value)
            self.assertFalse(record["namespace_evidence"]["proposal"]["approved_in_original"])
            self.assertFalse(record["boundaries"]["historical_mapping_recovered"])
            self.assertFalse(record["boundaries"]["human_source_review_claimed"])
        proposals = identity.strict((self.ns.parent / "mapping_proposals.json").read_bytes())
        self.assertTrue(all(p["approved"] is False for p in proposals["bindings"]))

    def test_external_manifest_pin_required_and_wrong_pin_rejected(self):
        self.materialize()
        for pin in (None, "", "0" * 64):
            with self.subTest(pin=pin), self.assertRaises(ValueError):
                self.load(pin if pin is not None else "not-a-pin")
        with self.assertRaisesRegex(ValueError, "external_manifest_pin_required"):
            identity.main(["--check"])

    def test_authorization_tamper_fails_even_when_resealed(self):
        self.materialize()
        auth = identity.strict((self.out / "authorization.json").read_bytes())
        auth["approval_text"] = "not approved"
        pin = self.reseal_output("authorization.json", identity.encoded(auth))
        with self.assertRaisesRegex(ValueError, "authorization_scope"):
            self.load(pin)

    def test_resealed_authorization_count_and_proposal_pin_tamper(self):
        self.materialize()
        original = (self.out / "authorization.json").read_bytes()
        for field in ("counts", "proposal_input"):
            auth = identity.strict(original)
            if field == "counts":
                auth[field]["approved_bindings"] = 84
            else:
                auth[field]["sha256"] = "0" * 64
            pin = self.reseal_output("authorization.json", identity.encoded(auth))
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "declaration_not_reproducible"):
                self.load(pin)

    def test_duplicate_binding_records_rejected(self):
        self.materialize()
        data = (self.out / "approved_bindings.jsonl").read_bytes()
        pin = self.reseal_output("approved_bindings.jsonl", data + data.splitlines(keepends=True)[0])
        with self.assertRaisesRegex(ValueError, "duplicate_binding_key"):
            self.load(pin)

    def test_binding_and_schema_tamper_rejected_after_reseal(self):
        self.materialize()
        original = (self.out / "approved_bindings.jsonl").read_bytes()
        records = [identity.strict(raw) for raw in original.splitlines()]
        records[0]["key"]["full_original_sentence_file_sha256"] = "f" * 64
        pin = self.reseal_output("approved_bindings.jsonl", b"".join(identity.encoded(r).replace(b"\n", b"") + b"\n" for r in records))
        with self.assertRaisesRegex(ValueError, "declaration_not_reproducible"):
            self.load(pin)
        self.reseal_output("approved_bindings.jsonl", original)
        pin = self.reseal_output("binding_schema.json", b"{}\n")
        with self.assertRaisesRegex(ValueError, "declaration_not_reproducible"):
            self.load(pin)

    def test_output_hash_and_extra_files_rejected(self):
        pin, _ = self.materialize()
        report = self.out / "report.json"
        data = report.read_bytes()
        report.write_bytes(data + b" ")
        with self.assertRaisesRegex(ValueError, "input_hash_mismatch"):
            self.load(pin)
        report.write_bytes(data)
        (self.out / "unexpected.json").write_bytes(b"{}")
        with self.assertRaisesRegex(ValueError, "unexpected_output_files"):
            self.load(pin)

    def test_namespace_manifest_and_inventory_external_pins(self):
        original = self.ns.read_bytes()
        self.ns.write_bytes(original + b" ")
        with self.assertRaisesRegex(ValueError, "input_hash_mismatch"):
            self.build()
        self.ns.write_bytes(original)
        self.gen.write_bytes(self.gen.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "input_hash_mismatch"):
            self.build()

    def test_all_namespace_outputs_and_input_metadata_pinned(self):
        for name in ("mapping_proposals.json", "per_work_bindings.jsonl", "metadata_inventory.json", "report.json", "report.md"):
            path = self.ns.parent / name
            original = path.read_bytes()
            path.write_bytes(original + b" ")
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "input_hash_mismatch"):
                self.build()
            path.write_bytes(original)
        chapter = Path(self.evidence[0]["metadata_refs"][0]["path"])
        chapter.write_bytes(chapter.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "input_hash_mismatch"):
            self.build()

    def test_coverage_generator_job_and_inventory_output_pinned(self):
        for name in ("coverage", "generator", "job"):
            path = Path(self.evidence[0]["artifacts"][name]["path"])
            original = path.read_bytes()
            path.write_bytes(original + b" ")
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "input_hash_mismatch"):
                self.build()
            path.write_bytes(original)
        path = self.gen.parent / "report.json"
        path.write_bytes(path.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "input_hash_mismatch"):
            self.build()

    def test_current_source_bytes_default_and_explicit_metadata_only(self):
        pin, _ = self.materialize()
        source = Path(self.evidence[10]["artifacts"]["sentences"]["path"])
        source.write_bytes(source.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "input_hash_mismatch"):
            self.load(pin)
        self.assertEqual(len(self.load(pin, verify_sources=False)), 83)

    def test_all_83_sources_hashed_and_final_rehashed(self):
        seen = []
        original_verify = identity.Inputs.verify

        def verify(reader, ref):
            seen.append(ref["path"])
            return original_verify(reader, ref)

        with mock.patch.object(identity.Inputs, "verify", verify):
            self.build()
        for item in self.evidence[:83]:
            self.assertGreaterEqual(seen.count(item["artifacts"]["sentences"]["path"]), 2)

    def test_final_source_mutation_blocks_completed_manifest(self):
        outputs, _, inputs = self.build()
        source = Path(self.evidence[0]["artifacts"]["sentences"]["path"])
        original_recheck = inputs.recheck
        calls = 0

        def recheck():
            nonlocal calls
            calls += 1
            if calls == 2:
                source.write_bytes(source.read_bytes() + b" ")
            original_recheck()

        with mock.patch.object(inputs, "recheck", side_effect=recheck):
            with self.assertRaisesRegex(ValueError, "final_metadata_changed"):
                identity.materialize(self.out, outputs, inputs)
        self.assertFalse((self.out / "manifest.json").exists())

    def test_source_mutation_after_reproduction_caught_by_loader_final_check(self):
        pin, _ = self.materialize()
        original_build = identity.build
        source = Path(self.evidence[82]["artifacts"]["sentences"]["path"])

        def late_mutation(*args, **kwargs):
            result = original_build(*args, **kwargs)
            source.write_bytes(source.read_bytes() + b" ")
            return result

        with mock.patch.object(identity, "build", side_effect=late_mutation):
            with self.assertRaisesRegex(ValueError, "final_metadata_changed"):
                self.load(pin)

    def test_no_original_writes_no_model_no_network_no_prose(self):
        originals = {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        with mock.patch.object(socket, "socket", side_effect=AssertionError("network forbidden")):
            pin, records = self.materialize()
            bindings = self.load(pin)
        for path, data in originals.items():
            self.assertEqual(path.read_bytes(), data)
        for path in self.out.iterdir():
            self.assertNotIn(b"PRIVATE_PROSE", path.read_bytes())
        self.assertEqual(len(bindings), 83)
        self.assertEqual(records[0]["boundaries"]["model_calls"], 0)
        self.assertEqual(records[0]["boundaries"]["network_calls"], 0)
        imports = [line for line in Path(identity.__file__).read_text("utf-8").splitlines()
                   if line.startswith(("import ", "from "))]
        self.assertFalse(any("validator" in line or "runner" in line or "openai" in line for line in imports))

    def test_absent_only_and_manifest_has_no_selfhash(self):
        outputs, _, inputs = self.build()
        self.assertFalse(self.out.exists())
        identity.materialize(self.out, outputs, inputs)
        manifest = identity.strict(outputs["manifest.json"])
        self.assertNotIn("manifest.json", manifest["outputs"])
        self.assertNotIn("sha256", manifest)
        with self.assertRaisesRegex(ValueError, "output_directory_already_exists"):
            identity.materialize(self.out, outputs, inputs)
        with self.assertRaisesRegex(ValueError, "output_outside_owned_directory"):
            identity.materialize(self.root / "foreign", outputs, inputs)

    def test_dryrun_and_check_cli_offline(self):
        build = identity.build
        with mock.patch.object(identity, "build", side_effect=lambda *args, **kw: build(self.ns, self.gen, **kw)):
            with contextlib.redirect_stdout(io.StringIO()) as captured:
                identity.main([])
            self.assertEqual(json.loads(captured.getvalue())["mode"], "dry_run")
            self.assertFalse(self.out.exists())
            with contextlib.redirect_stdout(io.StringIO()) as captured:
                identity.main(["--materialize", "newabsent"])
            pin = json.loads(captured.getvalue())["manifest_sha256"]
            with contextlib.redirect_stdout(io.StringIO()) as captured:
                identity.main(["--check", "--manifest-sha256", pin])
            self.assertEqual(json.loads(captured.getvalue())["bindings_verified"], 83)

    def test_strict_json_duplicates_and_path_escape(self):
        with self.assertRaisesRegex(ValueError, "duplicate_json_key"):
            identity.strict(b'{"approved":true,"approved":false}')
        with self.assertRaisesRegex(ValueError, "nonfinite_json"):
            identity.strict(b'{"value":NaN}')
        with self.assertRaisesRegex(ValueError, "unsafe_path"):
            identity.Inputs().path(self.root / ".." / "escape")


if __name__ == "__main__":
    unittest.main()
