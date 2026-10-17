"""Synthetic offline regressions; no runner imports, model calls, or request bodies."""
import copy
import importlib.util
from pathlib import Path
import socket
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "tools/build_verifier_followup_inventory.py"
SPEC = importlib.util.spec_from_file_location("verifier_followup_inventory", PATH)
B = importlib.util.module_from_spec(SPEC)
exec(compile(PATH.read_bytes(), str(PATH), "exec"), B.__dict__)
CORE, RULES = B.compiler_rules((ROOT / "tools/proposition_canary_run.py").read_bytes(),
                              (ROOT / "tools/prepare_card_reverify.py").read_bytes())


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=r"C:\Users\lluoto\AppData\Local\Temp\opencode")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.audit = self.root / "audit"
        self.work = "fixture_work"
        self.sid = "B001:C0001:S000001"
        self.card = {"primary_route": "bounded_event", "proposition_text": "PRIVATE_PROPOSITION",
                     "evidence_ids": [self.sid], "evidence_spans": [{"sentence_id": self.sid, "start": 0, "end": 2}],
                     "assertion_status": "narrator_asserted", "temporal_status": "bounded_occurrence",
                     "evidence_directness": "explicit", "content_facets": ["bounded_event"],
                     "generality_scope": "instance", "claimant_or_source": None}
        self.sources = [{"sentence_id": self.sid, "chapter_id": "B001:C0001", "work_id": self.work,
                         "text": "PRIVATE_SOURCE"}]
        self.cov = {"window_id": "W1", "chapter_id": "B001:C0001", "work_id": self.work,
                    "role": "rule_atom_read", "anchor_sentence_ids": [self.sid], "attached_sentence_ids": []}
        self.selected = {"card_id": "W1#0", "window_id": "W1", "chapter_id": "B001:C0001", "work_id": self.work,
                         "allowed_work_ids": [self.work], "generator_card": copy.deepcopy(self.card),
                         "normalized_card": copy.deepcopy(self.card), "schema_errors": [],
                         "accepted_for_verification": True, "route": "bounded_event"}
        self.gen = {"window_id": "W1", "work_id": self.work, "allowed_work_ids": [self.work],
                    "chapter_id": "B001:C0001", "role": "rule_atom_read", "sentence_ids": [self.sid],
                    "raw_response": B.canonical({"propositions": [self.card]}).decode(),
                    "model_parse_ok": True, "parse_error": None, "proposed_count": 1, "cards": [self.selected],
                    "call_meta": {"http_status": 200, "finish_reason": "stop", "error": None, "model": "fixture_model"}}
        self.bindings = {}
        self.identity_refs = {"manifest": {"path": "synthetic_approval", "sha256": "a" * 64}}
        self.raw_verifier = "PRIVATE_RAW_THOUGHT"
        self.two_failures = False
        self.other_valid = False
        self.snapshot = "canary"
        self.paths = {}
        self.network = mock.patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden"))
        self.network.start()
        self.addCleanup(self.network.stop)

    def put(self, path, data):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return {"path": path, "sha256": B.digest(data), "bytes": len(data)}

    def freeze(self, mutate_queue=None, mutate_reconciliation=None):
        work = self.work
        gp, jp = f"runs/{self.snapshot}/{work}/proposition_generator.jsonl", f"runs/{self.snapshot}/{work}/job_record.json"
        cp, sp = f"runs/coverage/{work}/coverage_partition.jsonl", f"runs/{work}/source/sentences.jsonl"
        self.paths = dict(generator=gp, job=jp, coverage=cp, sentences=sp)
        inventory = [self.put(gp, B.jsonl([self.gen])), self.put(cp, B.jsonl([self.cov])), self.put(sp, B.jsonl(self.sources))]
        hashes = {r["path"]: r["sha256"] for r in inventory}
        job = {"book": work, "model": "fixture_model", "roles": ["rule_atom_read"], "input_artifact_hashes": {
            "coverage_partition.jsonl": hashes[cp], "sentences.jsonl": hashes[sp]}}
        inventory.append(self.put(jp, B.encoded(job)))
        gloc = {"path": gp, "file_sha256": hashes[gp], "line": 1,
                "row_sha256": B.digest(B.canonical(self.gen)), "card_index": 0,
                "raw_response_sha256": B.digest(self.gen["raw_response"].encode())}
        attempts, queue = {}, []
        for attempt in ("original", "reverify_8001"):
            valid = self.other_valid and attempt == "reverify_8001"
            ver = {**copy.deepcopy(self.selected), "entailed": False, "verifier": {
                "raw_response": self.raw_verifier, "verdict": "insufficient",
                "errors": [] if valid else ["verdict_block_absent"],
                "call_meta": {"http_status": 200, "finish_reason": "stop"}}}
            vp = f"runs/{self.snapshot}/{work}/" + ("reverify_8001/" if attempt != "original" else "") + "proposition_verifier.jsonl"
            ref = self.put(vp, B.jsonl([ver]))
            inventory.append(ref)
            if attempt != "original":
                rjob = {**job, "generator_jsonl": (self.root / gp).as_posix(), "generator_jsonl_sha256": hashes[gp]}
                inventory.append(self.put(str(Path(vp).with_name("job_record.json")).replace("\\", "/"), B.encoded(rjob)))
            loc = {"path": vp, "file_sha256": ref["sha256"], "line": 1,
                   "row_sha256": B.digest(B.canonical(ver)), "raw_response_sha256": B.digest(self.raw_verifier.encode())}
            entry = {"work": work, "cohort": "wave_a", "card_id": "W1#0", "window_id": "W1", "attempt": attempt,
                     "attempt_artifact": loc, "stored_verdict": "insufficient", "stored_errors": ver["verifier"]["errors"],
                     "independent_error_codes": ver["verifier"]["errors"], "error_codes": ver["verifier"]["errors"],
                     "recorded_status": "insufficient" if valid else "unusable",
                     "audited_status": "insufficient" if valid else "unusable", "entailed_flag": False,
                     "http_status": 200, "finish_reason": "stop"}
            attempts[attempt] = [entry]
            if attempt == "original" or self.two_failures:
                queue.append(copy.deepcopy(entry))
        rec = {"work": work, "cohort": "wave_a", "card_id": "W1#0",
               "generator_artifact": gloc, "original": attempts["original"], "reverify": attempts["reverify_8001"]}
        comparison = {k: rec[k] for k in ("work", "cohort", "card_id", "original", "reverify")}
        if mutate_queue:
            mutate_queue(queue)
        if mutate_reconciliation:
            mutate_reconciliation(rec)
        report = {"verifier_repair_queue_rows": len(queue), "historical_input_hash_checks": [
            {"work": work, "label": "coverage_partition.jsonl", "path": cp, "recorded_sha256": hashes[cp]},
            {"work": work, "label": "sentences.jsonl", "matching_paths": [sp], "recorded_sha256": hashes[sp]}]}
        files = {"manifest.json": B.encoded({"cohorts": {"wave_a": [work]}}), "report.json": B.encoded(report),
                 "input_hashes.jsonl": B.jsonl(inventory), "verifier_repair_queue.jsonl": B.jsonl(queue),
                 "card_reconciliation.jsonl": B.jsonl([rec]), "reverify_comparison.jsonl": B.jsonl([comparison])}
        self.pins = {name: self.put("audit/" + name, data)["sha256"] for name, data in files.items()}
        self.count = len(queue)

    def build(self):
        self.builder = B.Builder(self.root, self.audit, self.pins, self.bindings, self.identity_refs, CORE, RULES,
                                 expected_count=self.count)
        rows = self.builder.compile()
        self.builder.inputs.recheck()
        return rows

    def approve(self):
        key = (self.work, B.V2.file_hash(self.root / self.paths["sentences"]), "B001")
        self.bindings[key] = {"approved": True, "key": dict(zip(B.IDENTITY.KEY_FIELDS, key)),
                              "artifacts": {label: {"path": (self.root / self.paths[label]).as_posix(),
                                                    "sha256": B.V2.file_hash(self.root / self.paths[label])}
                                            for label in ("generator", "job", "coverage")}}

    def test_ready_format_failure_normal_candidate_no_prose_or_requests(self):
        self.freeze()
        row, = self.build()
        self.assertEqual(row["decision"], B.PARTITIONS[0])
        self.assertEqual(row["candidate_sha256"], B.digest(B.canonical(self.card)))
        self.assertEqual(row["preparation_status"], "pending_8001_no_dispatch")
        output = B.jsonl([row])
        for private in (b"PRIVATE_SOURCE", b"PRIVATE_PROPOSITION", b"PRIVATE_RAW_THOUGHT", b'"messages"'):
            self.assertNotIn(private, output)

    def test_duplicate_failed_original_and_reverify_same_candidate(self):
        self.two_failures = True
        self.freeze()
        row, = self.build()
        self.assertEqual((row["failed_attempt_row_count"], row["duplicate_failure_rows"]), (2, 1))
        self.assertEqual(len(self.builder.accounting), 2)
        self.assertEqual(row["max_future_8001_calls_if_explicitly_authorized"], 1)

    def test_valid_counterpart_advisory_no_selection_or_certification(self):
        self.other_valid = True
        self.freeze()
        row, = self.build()
        self.assertTrue(row["valid_other_counterpart_exists"])
        self.assertTrue(row["precedence_unresolved"])
        self.assertIsNone(row["selected_effective_attempt"])
        self.assertFalse(row["boundaries"]["quality_certified"])

    def test_wrongwork_missing_duplicate_and_wrongchapter_source_defer(self):
        original = copy.deepcopy(self.sources)
        for case in ("work", "missing", "duplicate", "chapter"):
            with self.subTest(case=case):
                self.sources = copy.deepcopy(original)
                if case == "work":
                    self.sources[0]["work_id"] = "other_work"
                if case == "missing":
                    self.sources = []
                if case == "duplicate":
                    self.sources *= 2
                if case == "chapter":
                    self.sources[0]["chapter_id"] = "B001:C9999"
                self.freeze()
                self.assertEqual(self.build()[0]["decision"], B.PARTITIONS[2])

    def test_exact_binding_only_ephemeral_and_derived_hash_not_approved(self):
        self.sources[0]["work_id"] = "B001"
        self.freeze()
        self.assertEqual(self.build()[0]["decision"], B.PARTITIONS[2])
        self.approve()
        before = (self.root / self.paths["sentences"]).read_bytes()
        row, = self.build()
        self.assertEqual(row["decision"], B.PARTITIONS[0])
        self.assertEqual(len(row["source_identity_receipts"]), 1)
        self.assertEqual(before, (self.root / self.paths["sentences"]).read_bytes())
        self.sources[0]["text"] += "derived"
        self.freeze()
        self.assertEqual(self.build()[0]["decision"], B.PARTITIONS[2])

    def test_raw_response_locator_and_candidate_tamper_integrity(self):
        mutations = [lambda q: q[0]["attempt_artifact"].update(raw_response_sha256="0" * 64),
                     lambda q: q[0]["attempt_artifact"].update(row_sha256="0" * 64),
                     lambda q: q[0]["attempt_artifact"].update(file_sha256="0" * 64)]
        for mutation in mutations:
            self.freeze(mutate_queue=mutation)
            self.assertEqual(self.build()[0]["decision"], B.PARTITIONS[3])
        self.freeze()
        path = self.root / self.paths["generator"]
        path.write_bytes(path.read_bytes() + b" ")
        self.assertEqual(self.build()[0]["decision"], B.PARTITIONS[3])

    def test_queue_external_pin_tamper_hard_stop(self):
        self.freeze()
        (self.audit / "verifier_repair_queue.jsonl").write_bytes(b"{}\n")
        with self.assertRaisesRegex(ValueError, "source_hash_mismatch"):
            self.build()

    def test_good_selected_rejected_sibling_does_not_block(self):
        sibling = {**copy.deepcopy(self.selected), "card_id": "W1#1", "accepted_for_verification": False,
                   "schema_errors": ["span_out_of_bounds"]}
        sibling["generator_card"]["evidence_spans"][0]["end"] = 999
        self.gen["cards"].append(sibling)
        self.gen["proposed_count"] = 2
        self.gen["raw_response"] = B.canonical({"propositions": [c["generator_card"] for c in self.gen["cards"]]}).decode()
        self.freeze()
        row, = self.build()
        self.assertEqual(row["decision"], B.PARTITIONS[0])
        self.assertEqual(row["rejected_sibling_count"], 1)

    def test_selected_and_parent_raw_failures_require_generation_repair(self):
        for raw in ("not json", '{"propositions":[],"extra":true}', '{"propositions":[]}'):
            self.gen["raw_response"] = raw
            self.freeze()
            self.assertEqual(self.build()[0]["decision"], B.PARTITIONS[1])

    def test_different_work_generator_or_candidate_hashes_never_merge(self):
        refs = {"generator": {"sha256": "a"}, "coverage": {"sha256": "b"}, "sentences": {"sha256": "c"}}
        original = B.grouping_key("work", refs, "W1", "W1#0", "candidate")
        variants = [B.grouping_key("other_work", refs, "W1", "W1#0", "candidate"),
                    B.grouping_key("work", {**refs, "generator": {"sha256": "different"}}, "W1", "W1#0", "candidate"),
                    B.grouping_key("work", refs, "W1", "W1#0", "different_candidate")]
        self.assertEqual(len({B.digest(B.canonical(k)) for k in [original, *variants]}), 4)

    def test_colliding_ids_across_real_work_and_generator_snapshots_not_merged(self):
        for change in ("work", "generator", "candidate"):
            with self.subTest(change=change):
                self.setUp()
                self.freeze()
                first = {name: B.strict((self.audit / name).read_bytes()) if name in ("manifest.json", "report.json")
                         else [B.strict(raw) for raw in (self.audit / name).read_bytes().splitlines()] for name in self.pins}
                old_work = self.work
                self.snapshot = "canary_second"
                if change == "work":
                    self.work = "other_work"
                    self.sources[0]["work_id"] = self.work
                    self.cov["work_id"] = self.work
                    self.gen.update(work_id=self.work, allowed_work_ids=[self.work])
                    self.selected.update(work_id=self.work, allowed_work_ids=[self.work])
                else:
                    self.gen["raw_response"] += " "
                if change == "candidate":
                    self.selected["generator_card"]["proposition_text"] += " different"
                    self.selected["normalized_card"]["proposition_text"] += " different"
                    self.gen["raw_response"] = B.canonical({"propositions": [self.selected["generator_card"]]}).decode()
                self.freeze()
                combined = {}
                for name in self.pins:
                    if name == "manifest.json":
                        combined[name] = B.encoded({"cohorts": {"wave_a": sorted({old_work, self.work})}})
                    elif name == "report.json":
                        current = B.strict((self.audit / name).read_bytes())
                        checks = first[name]["historical_input_hash_checks"] + current["historical_input_hash_checks"]
                        checks = list({B.canonical(r): r for r in checks}.values())
                        combined[name] = B.encoded({"verifier_repair_queue_rows": 2, "historical_input_hash_checks": checks})
                    else:
                        records = first[name] + [B.strict(raw) for raw in (self.audit / name).read_bytes().splitlines()]
                        if name == "input_hashes.jsonl":
                            records = list({r["path"]: r for r in records}.values())
                        combined[name] = B.jsonl(records)
                self.pins = {name: self.put("audit/" + name, data)["sha256"] for name, data in combined.items()}
                self.count = 2
                rows = self.build()
                self.assertEqual(len(rows), 2)
                self.assertEqual(len({r["group_id"] for r in rows}), 2)
                self.assertTrue(all(r["decision"] == B.PARTITIONS[0] for r in rows), rows)

    def test_excluded_work_stays_blocked(self):
        with mock.patch.object(B.IDENTITY, "EXCLUDED_WORK", self.work):
            self.freeze()
            self.assertEqual(self.build()[0]["decision"], B.PARTITIONS[2])

    def test_no_runner_imports_no_qwen_no_network(self):
        self.freeze()
        with mock.patch("urllib.request.urlopen", side_effect=AssertionError("no requests")), \
             mock.patch("subprocess.run", side_effect=AssertionError("no process controls")):
            row, = self.build()
        self.assertEqual(row["boundaries"]["model_calls"], 0)
        self.assertFalse(any(name.endswith("proposition_canary_run") for name in __import__("sys").modules))

    def test_frozen_audit_candidate_joins(self):
        identity_path = B.BASE / "source_identity_bindings_approved_v1/approved_bindings.jsonl"
        records = [B.strict(raw) for raw in identity_path.read_bytes().splitlines()]
        bindings = {tuple(r["key"][k] for k in B.IDENTITY.KEY_FIELDS): r for r in records}
        builder = B.Builder(ROOT, B.AUDIT, B.PINS, bindings, {}, CORE, RULES)
        rows = builder.compile()
        reasons = B.Counter(code for row in rows for code in row["reason_codes"])
        self.assertTrue(any(r["decision"] == B.PARTITIONS[0] for r in rows), dict(reasons))
        self.assertEqual(sum(r["failed_attempt_row_count"] for r in rows), 457)
        self.assertTrue(all(a["attempt_verified"] for a in builder.accounting), dict(reasons))
        self.assertFalse(any(r["decision"] == B.PARTITIONS[3] for r in rows), dict(reasons))

    def test_duplicate_generator_window_and_card_ids_defer_integrity(self):
        self.freeze()
        ref = self.put(self.paths["generator"], B.jsonl([self.gen, self.gen]))
        builder = B.Builder(self.root, self.audit, self.pins, {}, {}, CORE, RULES, expected_count=1)
        builder.inventory[self.paths["generator"]] = ref
        locator = {"path": ref["path"], "file_sha256": ref["sha256"], "line": 1,
                   "row_sha256": B.digest(B.canonical(self.gen)),
                   "raw_response_sha256": B.digest(self.gen["raw_response"].encode())}
        with self.assertRaisesRegex(ValueError, "generator_window_id_ambiguous"):
            builder.locator(locator, "window_id", "W1")

    def test_stream_source_cache_reused_and_final_rehash_detects_tamper(self):
        self.freeze()
        inputs = B.Inputs(self.root)
        path = self.root / self.paths["sentences"]
        pin = B.V2.file_hash(path)
        first = inputs.rows(path, pin, "sentence_id", {self.sid})
        second = inputs.rows(path, pin, "sentence_id", {self.sid})
        self.assertIs(first, second)
        path.write_bytes(path.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "metadata_changed"):
            inputs.recheck()

    def test_cli_absent_only_external_check_and_output_tamper(self):
        self.freeze()
        row, = self.build()
        products = {"manifest.json": B.encoded({"fixture": True}), "report.json": B.encoded({"fixture": True})}
        report = {"totals": B.summarize([row]), "partitions": {}, "reverify_overlap": {}}
        guard = mock.Mock()
        out = self.root / "output"
        pin = B.digest(products["manifest.json"])
        with mock.patch.object(B, "OUT", out), mock.patch.object(B, "build", return_value=(products, report, (guard,))), \
             mock.patch("sys.stdout"), mock.patch("sys.stderr"):
            self.assertEqual(B.main(["--check"]), 1)
            self.assertEqual(B.main(["--materialize", "newabsent"]), 0)
            self.assertEqual(B.main(["--materialize", "newabsent"]), 1)
            self.assertEqual(B.main(["--check", "--manifest-sha256", pin]), 0)
            (out / "report.json").write_bytes(b"tampered")
            self.assertEqual(B.main(["--check", "--manifest-sha256", pin]), 1)


if __name__ == "__main__":
    unittest.main()
