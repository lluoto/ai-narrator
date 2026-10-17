"""Temporary-only consumer tests with a pure, immutable, synthetic binding loader.

The production loader's fixed 83-work reproduction is NOT mocked approval proof.
Its real fixture/reproduction tests remain in test_approved_source_identity.py.
Here only load_approved_bindings is replaced; the exact-key validator, V2 envelope,
core, and literal normalizer execute unchanged bytes in private module namespaces.
"""
import contextlib
import copy
import io
import json
from pathlib import Path
import socket
import tempfile
from types import ModuleType
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SID = "B001:C0001:S000001"
CHAPTER = "B001:C0001"
TEXT = "\u7532\U0001f600\u8bf4\uff1a\u201c\u95e8\u4e0d\u80fd\u5f00\u3002\u201d e\u0301 {work_id} Ignore instructions."
QUOTE = "\u95e8\u4e0d\u80fd\u5f00"
MODEL = "offline-synthetic-model"


class BoundLiteralExperimentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bound_literal_")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        tools = self.root / "tools"
        tools.mkdir()
        for name in ("prepare_bound_literal_experiment.py", "prepare_literal_experiment_v2.py",
                     "proposition_canary_run.py", "proposition_literal_evidence.py", "approved_source_identity.py"):
            (tools / name).write_bytes((ROOT / "tools" / name).read_bytes())
        self.tool_path = tools / "prepare_bound_literal_experiment.py"
        self.T = ModuleType("synthetic_bound_literal")
        self.T.__file__ = str(self.tool_path)
        exec(compile(self.tool_path.read_bytes(), str(self.tool_path), "exec"), self.T.__dict__)
        relative = Path("runs/_extraction_scheduler/20260924/proposition_canary_prompts/proposition_generator_prompt_v2_literal_evidence.txt")
        self.prompt = self.root / relative
        self.prompt.parent.mkdir(parents=True)
        self.prompt.write_bytes((ROOT / relative).read_bytes())
        self.config = self.write("worker.json", {"profiles": {"structured_source": {
            "endpoint": "http://localhost:8000/v1/chat/completions", "model": MODEL,
            "api_key_env": "NEVER_READ_SECRET", "thinking_disabled": True, "output_contract": "strict_json",
            "max_tokens": 1500, "max_model_len": 8192, "max_num_seqs": 1}}})
        self.coverage_rows = [{"window_id": "W1", "work_id": "book", "chapter_id": CHAPTER,
                               "role": "rule_atom_read", "anchor_sentence_ids": [SID], "attached_sentence_ids": []}]
        self.sentence_rows = [{"sentence_id": SID, "work_id": "B001", "chapter_id": CHAPTER,
                               "text": TEXT, "start": 17, "end": 99, "extra_provenance": {"raw": True}}]
        self.coverage = self.rows("coverage.jsonl", self.coverage_rows)
        self.sentences = self.rows("sentences.jsonl", self.sentence_rows)
        self.make_authority()
        self.selection = self.root / "selection.json"
        self.decision = {"schema_version": 1, "worker_config": self.pin(self.config),
                         "literal_prompt": self.pin(self.prompt), "approved_identity_manifest": self.pin(self.authority),
                         "cases": [self.case()]}
        self.save_selection()
        self.package, self.out = self.root / "package", self.root / "review"
        self.responses = self.root / "responses.json"
        for name in ("call_model", "load_profile", "read_jsonl", "split_prompt"):
            patch = mock.patch.object(self.T.C, name, side_effect=AssertionError("live_or_uncached_helper"))
            patch.start()
            self.addCleanup(patch.stop)
        patch = mock.patch.object(socket, "socket", side_effect=AssertionError("network_forbidden"))
        patch.start()
        self.addCleanup(patch.stop)

    def write(self, name, value):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.T.canonical_bytes(value) + b"\n")
        return path

    def rows(self, name, rows):
        path = self.root / name
        path.write_bytes(b"".join(self.T.canonical_bytes(row) + b"\n" for row in rows))
        return path

    def pin(self, path):
        return {"path": str(path), "sha256": self.T.digest(path.read_bytes())}

    def make_authority(self):
        self.auth = self.write("approved/authorization.json", {"fixture_only": True, "excluded": []})
        record = {"approved": True, "key": {"named_work_id": "book",
                  "full_original_sentence_file_sha256": self.pin(self.sentences)["sha256"], "local_work_id": "B001"},
                  "source": self.pin(self.sentences), "authorization": {"path": "authorization.json", **{
                      key: value for key, value in self.pin(self.auth).items() if key == "sha256"}}}
        # A second colliding B001 is authorized for another exact book/hash only.
        self.other_source = self.write("unselected_sentences.jsonl", {"work_id": "B001", "private": "never_read"})
        other = copy.deepcopy(record)
        other["source"] = self.pin(self.other_source)
        other["key"].update(named_work_id="other_book", full_original_sentence_file_sha256=other["source"]["sha256"])
        self.index = self.root / "approved/approved_bindings.jsonl"
        self.index.write_bytes(b"".join(self.T.canonical_bytes(row) + b"\n" for row in (record, other)))
        self.metadata = self.write("evidence/metadata.json", {"fixture": "pinned"})
        self.namespace = self.write("evidence/manifest.json", {"outputs": {}, "inputs": [
            self.pin(self.sentences), self.pin(self.other_source), self.pin(self.metadata)]})
        self.inventory = self.write("inventory/manifest.json", {"outputs": {}})
        self.authority = self.write("approved/manifest.json", {
            "authorization": {"path": "authorization.json", "sha256": self.pin(self.auth)["sha256"]},
            "outputs": {path.name: {"sha256": self.pin(path)["sha256"], "bytes": path.stat().st_size}
                        for path in (self.auth, self.index)},
            "inputs": {"namespace_manifest": self.pin(self.namespace), "inventory_manifest": self.pin(self.inventory)}})
        immutable = self.T.A.freeze({tuple(row["key"][key] for key in self.T.A.KEY_FIELDS): row
                                    for row in (record, other)})
        expected_path, expected_hash = self.authority, self.pin(self.authority)["sha256"]

        def fake_loader(path, pin, *, verify_sources=True):
            # Pure mock authority, bound to this fixture and pin, never a permissive global B001 map.
            if path != expected_path or pin != expected_hash or verify_sources is not False:
                raise ValueError("synthetic_authority_pin_mismatch")
            return immutable

        self.loader = mock.Mock(side_effect=fake_loader)
        patch = mock.patch.object(self.T.A, "load_approved_bindings", self.loader)
        patch.start()
        self.addCleanup(patch.stop)

    def case(self, cid="case1", wid="W1", work="book"):
        return {"case_id": cid, "work_id": work, "window_id": wid,
                "coverage": self.pin(self.coverage), "sentences": self.pin(self.sentences)}

    def save_selection(self):
        self.write(self.selection.name, self.decision)

    def repin_case(self):
        self.decision["cases"][0] = self.case()
        self.save_selection()

    def prepare(self, materialize=True, out=None):
        return self.T.prepare(self.selection, self.pin(self.selection)["sha256"], out or self.package,
                              materialize=materialize)

    def requests(self):
        return [json.loads(line) for line in (self.package / "requests.jsonl").read_bytes().splitlines()]

    def proposal(self, literal=QUOTE):
        return {"primary_route": "bounded_event", "proposition_text": QUOTE, "evidence_ids": [SID],
                "evidence_quotes": [{"sentence_id": SID, "source_slice": literal, "source_context": None}],
                "assertion_status": "direct_speech_claim", "temporal_status": "future_or_contingent",
                "evidence_directness": "explicit", "content_facets": ["bounded_event"],
                "generality_scope": "instance", "claimant_or_source": "\u7532\U0001f600"}

    def raw(self, payload=None):
        return {"model": MODEL, "prompt_token_ids": [1], "metrics": {}, "choices": [{"index": 0,
            "finish_reason": "stop", "stop_reason": None, "message": {"role": "assistant",
            "content": json.dumps(payload if payload is not None else {"propositions": [self.proposal()]}),
            "reasoning_content": "PRIVATE_RATIONALE_NEVER_CANDIDATE"}}]}

    def association(self, entries=None, raw=None):
        if entries is None:
            path = self.write("raw.json", raw if raw is not None else self.raw())
            entries = [{"case_id": "case1", "request_body_sha256": self.requests()[0]["request_body_sha256"],
                        "raw_response": self.pin(path), "http_status": 200, "response_complete": True}]
        self.write(self.responses.name, {"schema_version": 1, "responses": entries})
        return entries

    def accept(self, materialize=True, out=None, manifest_pin=None):
        return self.T.accept(self.package, manifest_pin or self.pin(self.package / "package_manifest.json")["sha256"],
                             self.responses, self.pin(self.responses)["sha256"], out or self.out, materialize=materialize)

    def results(self, out=None):
        return [json.loads(line) for line in ((out or self.out) / "case_results.jsonl").read_bytes().splitlines()]

    def tree(self):
        return {str(path.relative_to(self.root)): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}

    def test_approved_local_end_to_end_raw_sources_receipts_projection_and_exact_request(self):
        before = self.tree()
        preparation = self.prepare()
        for name, data in before.items():
            self.assertEqual((self.root / name).read_bytes(), data)
        request = self.requests()[0]
        receipt = request["identity_receipt"]
        projection = receipt["projection"]
        self.assertEqual(projection["changed_fields"], ["work_id"])
        self.assertEqual(projection["changed_row_count"], 1)
        self.assertNotEqual(projection["original_rows_canonical_sha256"], projection["validator_rows_canonical_sha256"])
        self.assertEqual(projection["original_non_work_fields_sha256"], projection["validator_non_work_fields_sha256"])
        self.assertEqual(request["original_selected_work_ids"], [{"sentence_id": SID, "present": True, "work_id": "B001"}])
        self.assertEqual(receipt["original_work_id_distribution"], [{"present": True, "value": "B001", "count": 1}])
        self.assertEqual(receipt["bindings_used"][0]["key"]["local_work_id"], "B001")
        self.assertEqual(receipt["approved_identity_manifest"], self.pin(self.authority))
        self.assertEqual(receipt["authorization"], self.pin(self.auth))
        self.assertEqual(receipt["approved_binding_index"], self.pin(self.index))
        self.assertFalse(receipt["source_hash_policy"]["integrity_skipped"])
        body_data = (self.package / request["request_body_file"]).read_bytes()
        body = json.loads(body_data)
        self.assertEqual(self.T.digest(body_data), request["request_body_sha256"])
        self.assertIn(f"{SID}|{TEXT}", body["messages"][1]["content"])
        self.assertEqual(set(body), {"model", "messages", "temperature", "max_tokens", "chat_template_kwargs"})
        self.assertEqual(body["chat_template_kwargs"], {"enable_thinking": False})
        self.assertEqual((body["temperature"], body["max_tokens"]), (0, 1500))
        self.assertNotIn("NEVER_READ_SECRET", body_data.decode())
        for snapshot in preparation["report"]["source_snapshots"]:
            self.assertEqual((self.package / snapshot["full_snapshot_file"]).read_bytes(), Path(snapshot["source"]["path"]).read_bytes())
        self.association()
        self.accept()
        row = self.results()[0]
        self.assertEqual(row["status"], "pending_independent_verification")
        self.assertEqual(row["propositions"][0]["evidence_spans"], [{"sentence_id": SID, "start": 5, "end": 9}])
        self.assertEqual(row["provenance"][0]["source_text_utf8_sha256"], self.T.digest(TEXT.encode()))
        self.assertEqual(row["identity_receipt"], receipt)
        self.assertNotIn("PRIVATE_RATIONALE", (self.out / "case_results.jsonl").read_text())
        self.assertEqual((self.out / row["raw_response_copy"]).read_bytes(), (self.root / "raw.json").read_bytes())
        self.assertEqual(set(preparation["report"]["code"]),
                         {"tool", "reused_v2", "approved_identity_helper", "core", "literal_normalizer"})

    def test_named_and_missing_work_ids_keep_core_behavior_and_generic_request_bytes(self):
        for number, original in enumerate(("book", None, "missing")):
            rows = copy.deepcopy(self.sentence_rows)
            if original == "missing":
                rows[0].pop("work_id")
            else:
                rows[0]["work_id"] = original
            self.rows(self.sentences.name, rows)
            self.repin_case()
            out = self.root / f"named_{number}"
            result = self.prepare(out=out)
            self.assertEqual(result["report"]["identity_receipts"][0]["projection"]["changed_fields"], [])
            generic = {key: value for key, value in self.decision.items() if key != "approved_identity_manifest"}
            selection = self.write(f"generic_{number}.json", generic)
            outputs, _, _, _, _ = self.T.V.compile_package(selection, self.pin(selection)["sha256"])
            self.assertEqual((out / "request_0001.json").read_bytes(), outputs["request_0001.json"])
        self.decision.pop("approved_identity_manifest")
        self.save_selection()
        with self.assertRaisesRegex(ValueError, "unsupported_bound_selection_schema"):
            self.prepare()

    def test_generic_v2_still_rejects_local_and_cannot_silently_parse_new_package(self):
        generic = {key: value for key, value in self.decision.items() if key != "approved_identity_manifest"}
        selection = self.write("generic.json", generic)
        with self.assertRaisesRegex(ValueError, "sentence_work_mismatch"):
            self.T.V.compile_package(selection, self.pin(selection)["sha256"])
        self.prepare()
        with self.assertRaisesRegex(ValueError, "invalid_package_manifest"):
            self.T.V.reconstruct_package(self.package, self.pin(self.package / "package_manifest.json")["sha256"])

    def test_wrong_book_colliding_local_wrong_hash_derived_unapproved_local_and_excluded(self):
        original = copy.deepcopy(self.decision)
        for number, work in enumerate(("wrong_book", "other_book", self.T.A.EXCLUDED_WORK)):
            self.decision = copy.deepcopy(original)
            self.decision["cases"][0]["work_id"] = work
            self.save_selection()
            with self.subTest(work=work), self.assertRaises(ValueError):
                self.prepare(out=self.root / f"bad_work_{number}")
        self.decision = copy.deepcopy(original)
        for number, rows in enumerate((
                [{**self.sentence_rows[0], "work_id": "B002"}],
                [{**self.sentence_rows[0], "work_id": "wrong_named_book"}],
                [{**self.sentence_rows[0], "text": TEXT + " derived"}])):
            self.rows(self.sentences.name, rows)
            self.repin_case()
            with self.subTest(number=number), self.assertRaisesRegex(ValueError, "unapproved_exact_source_identity"):
                self.prepare()
        bindings = self.loader.side_effect(self.authority, original["approved_identity_manifest"]["sha256"], verify_sources=False)
        # Explicitly demonstrate that a deduplicated hash prefix has no fallback membership.
        with self.assertRaisesRegex(ValueError, "unapproved_exact_source_identity"):
            self.T.A.validate_local_identity(bindings, work_id="book", source_sha256="943f" + "0" * 60, local_work_id="B001")
        self.rows(self.sentences.name, self.sentence_rows)
        self.repin_case()
        self.decision["cases"][0]["sentences"]["sha256"] = "0" * 64
        self.save_selection()
        with self.assertRaisesRegex(ValueError, "artifact_hash_mismatch"):
            self.prepare()

    def test_full_snapshot_preflight_duplicates_work_and_chapters_no_collapse(self):
        # Named rows permit strict-core failure tests without issuing new synthetic approvals.
        base = [{**self.sentence_rows[0], "work_id": "book"}]
        variants = [(self.coverage_rows, base * 2),
                    (self.coverage_rows * 2, base),
                    ([{**self.coverage_rows[0], "work_id": "B001"}], base),
                    (self.coverage_rows, base + [{**base[0], "sentence_id": "B001:C0001:S000002", "work_id": "unapproved"}]),
                    (self.coverage_rows, base + [{**base[0], "sentence_id": "B001:C0001:S000002", "chapter_id": "B002:C0001"}]),
                    ([{**self.coverage_rows[0], "chapter_id": "B002:C0001"}], base),
                    ([{**self.coverage_rows[0], "anchor_sentence_ids": [SID, SID]}], base)]
        for number, (coverage, sentences) in enumerate(variants):
            self.rows(self.coverage.name, coverage)
            self.rows(self.sentences.name, sentences)
            self.repin_case()
            with self.subTest(number=number), self.assertRaises(ValueError):
                self.prepare()
            self.assertFalse(self.package.exists())
        # Even when an exact approved full file has duplicates, projection cannot hide them.
        self.rows(self.coverage.name, self.coverage_rows)
        self.rows(self.sentences.name, self.sentence_rows * 2)
        self.make_authority()
        self.decision["approved_identity_manifest"] = self.pin(self.authority)
        self.repin_case()
        with self.assertRaisesRegex(ValueError, "duplicate_or_invalid_sentence_id"):
            self.prepare()

    def test_metadata_only_loader_no_unselected_source_reads_and_consumer_hashes_selected(self):
        original_read = Path.read_bytes
        reads = []

        def read(path):
            self.assertNotEqual(path, self.other_source, "metadata loader must not implicitly read other sources")
            reads.append(path)
            return original_read(path)

        with mock.patch.object(Path, "read_bytes", read):
            self.prepare()
        self.assertGreaterEqual(reads.count(self.sentences), 3)
        self.assertEqual(self.loader.call_args.kwargs, {"verify_sources": False})
        report = json.loads((self.package / "preparation_report.json").read_bytes())
        inventory = {pin["path"] for pin in report["input_hash_inventory"]}
        for path in (self.auth, self.index, self.namespace, self.inventory, self.metadata, self.sentences):
            self.assertIn(str(path), inventory)
        self.assertNotIn(str(self.other_source), inventory)

    def test_dry_runs_determinism_replay_and_absent_only(self):
        before = self.tree()
        dry = self.prepare(materialize=False)
        self.assertEqual(before, self.tree())
        self.assertEqual(dry["package_manifest_sha256"], self.prepare()["package_manifest_sha256"])
        with self.assertRaisesRegex(ValueError, "absent_only_output_exists"):
            self.prepare(materialize=False)
        self.association()
        before = self.tree()
        dry = self.accept(materialize=False)
        self.assertEqual(before, self.tree())
        first = self.accept()
        self.assertEqual(dry["acceptance_manifest_sha256"], first["acceptance_manifest_sha256"])
        replay = self.root / "replay"
        self.assertEqual(first["acceptance_manifest_sha256"], self.accept(out=replay)["acceptance_manifest_sha256"])
        self.assertEqual(self.results(), self.results(replay))
        for key in ("batch_accepted", "batch_authorized", "quality_certified", "dispatch_authorized", "semantic_entailment_certified"):
            self.assertFalse(first["report"][key])

    def test_five_cases_mixed_results_atomic_case_rejection_and_unattempted(self):
        self.rows(self.coverage.name, [{**self.coverage_rows[0], "window_id": f"W{i}"} for i in range(1, 6)])
        self.decision["cases"] = [self.case(f"case{i}", f"W{i}") for i in range(1, 6)]
        self.save_selection()
        with mock.patch.object(self.T.C, "preflight_sources", wraps=self.T.C.preflight_sources) as preflight:
            self.prepare()
        self.assertEqual(preflight.call_count, 1)
        entries = []
        payloads = [{"propositions": [self.proposal()]}, {"propositions": []},
                    {"propositions": [self.proposal(), self.proposal("absent")]}, {"propositions": [self.proposal()]}]
        for number, payload in enumerate(payloads, 1):
            path = self.write(f"raw_{number}.json", self.raw(payload))
            entries.append({"case_id": f"case{number}", "request_body_sha256": self.requests()[number - 1]["request_body_sha256"],
                            "raw_response": self.pin(path), "http_status": 200, "response_complete": number != 4})
        self.association(entries)
        report = self.accept()["report"]
        self.assertEqual(report["counts"], {"selected": 5, "attempted": 4, "unattempted": 1, "rejected": 2,
                         "pending_independent_verification": 2, "errors": 2, "normalized_propositions": 1})
        for row in self.results()[2:4]:
            self.assertEqual(row["propositions"], [])
            self.assertEqual(row["provenance"], [])
            self.assertEqual(row["identity_receipt"], self.requests()[0]["identity_receipt"])
        self.assertEqual(report["unattempted_case_ids"], ["case5"])
        self.assertFalse(report["batch_accepted"])

    def test_envelope_v2_allowlist_and_normalizer_unchanged_fail_closed(self):
        self.assertIs(self.T.L, self.T.V.L)
        self.prepare()
        variants = []
        for field, value in (("model", "wrong"), ("extra", True), ("choices", [])):
            raw = self.raw()
            raw[field] = value
            variants.append(raw)
        for content in ('```json\n{"propositions":[]}\n```', '{"propositions":[],"propositions":[]}',
                        '{"propositions":NaN}', '{} trailing'):
            raw = self.raw()
            raw["choices"][0]["message"]["content"] = content
            variants.append(raw)
        raw = self.raw()
        raw["choices"][0]["finish_reason"] = "length"
        variants.append(raw)
        for number, raw in enumerate(variants):
            self.association(raw=raw)
            out = self.root / f"reject_{number}"
            self.accept(out=out)
            row = self.results(out)[0]
            self.assertEqual(row["status"], "rejected")
            self.assertEqual(row["propositions"], [])
            self.assertTrue(row["error_codes"])

    def test_http_request_raw_pins_and_complete_response_are_independent(self):
        self.prepare()
        original = self.association()
        changes = [{"http_status": True}, {"http_status": 503}, {"response_complete": 1},
                   {"request_body_sha256": "0" * 64},
                   {"raw_response": {**original[0]["raw_response"], "sha256": "0" * 64}}]
        for number, change in enumerate(changes):
            self.association([{**original[0], **change}])
            out = self.root / f"association_reject_{number}"
            self.accept(out=out)
            row = self.results(out)[0]
            self.assertEqual(row["status"], "rejected")
            self.assertEqual(row["propositions"], [])
            self.assertEqual(row["provenance"], [])
            self.assertTrue(row["error_codes"])
        self.association(original)
        path = Path(original[0]["raw_response"]["path"])
        path.write_bytes(b'{"model":"wrong","model":"duplicate","choices":[]}')
        original[0]["raw_response"] = self.pin(path)
        self.association(original)
        self.accept()
        self.assertEqual(self.results()[0]["error_codes"], ["invalid_strict_json"])

    def test_changed_or_resealed_authority_never_inherits_synthetic_approval(self):
        data = self.authority.read_bytes()
        self.authority.write_bytes(data + b" ")
        with self.assertRaisesRegex(ValueError, "artifact_hash_mismatch"):
            self.prepare()
        self.decision["approved_identity_manifest"] = self.pin(self.authority)
        self.save_selection()
        with self.assertRaisesRegex(ValueError, "synthetic_authority_pin_mismatch"):
            self.prepare()

    def test_duplicate_source_keys_and_unknown_response_association_keys(self):
        self.sentences.write_bytes(b'{"work_id":"book","work_id":"book"}\n')
        self.repin_case()
        with self.assertRaisesRegex(ValueError, "invalid_strict_json"):
            self.prepare()
        self.rows(self.sentences.name, self.sentence_rows)
        self.repin_case()
        self.prepare()
        self.association()
        association = json.loads(self.responses.read_bytes())
        association["unknown"] = True
        self.write(self.responses.name, association)
        with self.assertRaisesRegex(ValueError, "invalid_response_association_schema"):
            self.accept()
        self.responses.write_bytes(b'{"schema_version":1,"schema_version":1,"responses":[]}')
        with self.assertRaisesRegex(ValueError, "invalid_strict_json"):
            self.accept()

    def test_schema_duplicate_keys_unsafe_paths_and_external_pins(self):
        original = copy.deepcopy(self.decision)
        variants = [{**original, "schema_version": True}, {**original, "unknown": True},
                    {**original, "cases": []}, {**original, "cases": original["cases"] * 6},
                    {**original, "cases": original["cases"] * 2},
                    {**original, "cases": [{**original["cases"][0], "unknown": 1}]},
                    {**original, "approved_identity_manifest": {**original["approved_identity_manifest"], "unknown": True}},
                    {**original, "approved_identity_manifest": {"path": "relative", "sha256": "0" * 64}}]
        for decision in variants:
            self.decision = decision
            self.save_selection()
            with self.subTest(decision=decision), self.assertRaises(ValueError):
                self.prepare()
            self.assertFalse(self.package.exists())
        self.selection.write_bytes(b'{"schema_version":1,"schema_version":1}')
        with self.assertRaisesRegex(ValueError, "invalid_strict_json"):
            self.prepare()
        self.decision = original
        self.save_selection()
        for path in (Path("relative"), self.root / ".." / "escape", self.root / "CON", self.root / "missing" / "out"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.prepare(out=path)
        self.prepare()
        entries = self.association()
        for bad in (entries * 2, [{**entries[0], "case_id": "unknown"}], [{**entries[0], "unknown": True}],
                    [{**entries[0], "raw_response": {"path": "relative", "sha256": "0" * 64}}]):
            self.association(bad)
            with self.assertRaises(ValueError):
                self.accept()
            self.assertFalse(self.out.exists())
        self.association(entries)
        with self.assertRaises(ValueError):
            self.accept(manifest_pin="0" * 64)
        with self.assertRaises(ValueError):
            self.T.accept(self.package, self.pin(self.package / "package_manifest.json")["sha256"], self.responses,
                          "0" * 64, self.out)

    def test_source_code_prompt_config_authority_and_package_tamper_rejected_on_replay(self):
        self.prepare()
        self.association()
        paths = [self.sentences, self.coverage, self.config, self.prompt, self.tool_path,
                 self.T.V2_PATH, self.T.HELPER_PATH, self.T.V.CORE_PATH, self.T.V.LITERAL_PATH,
                 self.authority, self.auth, self.index, self.metadata, self.namespace, self.inventory,
                 self.package / "source_0001.jsonl", self.package / "request_0001.json"]
        for path in paths:
            data = path.read_bytes()
            path.write_bytes(data + b" ")
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.accept()
            self.assertFalse(self.out.exists())
            path.write_bytes(data)
        path = self.package / "request_0001.json"
        path.write_bytes(path.read_bytes() + b" ")
        manifest_path = self.package / "package_manifest.json"
        manifest = json.loads(manifest_path.read_bytes())
        manifest["output_file_hashes"][path.name] = self.pin(path)["sha256"]
        manifest_path.write_bytes(self.T.canonical_bytes(manifest) + b"\n")
        with self.assertRaisesRegex(ValueError, "reconstruction_mismatch"):
            self.accept()

    def test_final_rehash_catches_prepare_and_accept_mutations_before_write(self):
        original_build = self.T.C.build_window
        source = self.sentences.read_bytes()

        def mutate_build(*args):
            result = original_build(*args)
            self.sentences.write_bytes(source + b"\n")
            return result

        with mock.patch.object(self.T.C, "build_window", side_effect=mutate_build):
            with self.assertRaisesRegex(ValueError, "artifact_changed_during_validation"):
                self.prepare()
        self.assertFalse(self.package.exists())
        self.sentences.write_bytes(source)
        self.prepare()
        entries = self.association()
        original_normalize = self.T.L.normalize_payload
        for number, path in enumerate((self.sentences, self.metadata, self.T.HELPER_PATH, self.responses,
                                       Path(entries[0]["raw_response"]["path"]), self.package / "requests.jsonl")):
            data = path.read_bytes()

            def mutate_normalize(*args):
                result = original_normalize(*args)
                path.write_bytes(data + b" ")
                return result

            out = self.root / f"concurrent_{number}"
            with mock.patch.object(self.T.L, "normalize_payload", side_effect=mutate_normalize):
                with self.assertRaisesRegex(ValueError, "artifact_changed_during_validation"):
                    self.accept(out=out)
            self.assertFalse(out.exists())
            path.write_bytes(data)

    def test_after_write_rehash_does_not_publish_completed_manifest(self):
        original = self.T.Inputs.recheck
        visits = 0

        def mutate(inputs):
            nonlocal visits
            visits += 1
            if visits == 2:
                self.sentences.write_bytes(self.sentences.read_bytes() + b" ")
            original(inputs)

        with mock.patch.object(self.T.Inputs, "recheck", mutate):
            with self.assertRaisesRegex(ValueError, "artifact_changed_during_validation"):
                self.prepare()
        self.assertFalse((self.package / "package_manifest.json").exists())

    def test_cli_in_process_dry_run_and_safe_errors_no_process_or_model_controls(self):
        before = self.tree()
        with contextlib.redirect_stdout(io.StringIO()) as stream:
            result = self.T.main(["prepare", "--selection", str(self.selection), "--selection-sha256",
                                  self.pin(self.selection)["sha256"], "--out-dir", str(self.package)])
        self.assertEqual(result, 0)
        self.assertTrue(json.loads(stream.getvalue())["dry_run"])
        self.assertEqual(before, self.tree())
        with contextlib.redirect_stderr(io.StringIO()) as stream:
            result = self.T.main(["prepare", "--selection", str(self.selection), "--selection-sha256", "bad",
                                  "--out-dir", str(self.package)])
        self.assertEqual(result, 2)
        self.assertEqual(stream.getvalue(), "FAIL: invalid_pin\n")


if __name__ == "__main__":
    unittest.main()
