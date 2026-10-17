"""Offline fixtures only. No network, model, production runner or real source imports."""
import copy
import importlib.util
import json
from pathlib import Path
import socket
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).absolute().parents[1]
PATH = ROOT / "tools/prepare_luna_conflict_review.py"
SPEC = importlib.util.spec_from_file_location("luna_preparation_test", PATH)
P = importlib.util.module_from_spec(SPEC)
exec(compile(PATH.read_bytes(), str(PATH), "exec"), P.__dict__)
SECRET = "PRIVATE_COT_AND_RAW_RESPONSE_MUST_NOT_BE_COPIED"
SID = "B001:C0001:S000001"
SID2 = "B001:C0001:S000002"


class PreparationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.audit = self.root / P.AUDIT
        self.audit.mkdir(parents=True)
        (self.root / "tools").mkdir()
        (self.root / "tests").mkdir()
        (self.root / "tools/prepare_luna_conflict_review.py").write_bytes(PATH.read_bytes())
        (self.root / "tests/test_luna_conflict_review.py").write_bytes(Path(__file__).read_bytes())
        self.out = self.root / P.OUT
        self.cards = 1
        self.work_names = ["fixture-a"]
        self.local_work = None
        self.duplicate_source = False
        self.duplicate_reconciliation = False
        self.duplicate_comparison = False
        self.mismatch = None
        self.different_raw = False
        self.invalid_span = False
        self.make_bindings = False
        self.bad_binding_work = False
        self.extra_check = False
        self.refresh()
        patch = mock.patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden"))
        patch.start()
        self.addCleanup(patch.stop)

    def save(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return {"path": path.relative_to(self.root).as_posix(), "sha256": P.sha(data), "bytes": len(data)}

    def obj(self, name, obj):
        return self.save(name, P.encoded(obj))

    def rows(self, name, rows):
        return self.save(name, b"".join(P.encoded(r) for r in rows))

    @staticmethod
    def loc(ref, number, row, response, **extra):
        return {"path": ref["path"], "file_sha256": ref["sha256"], "line": number,
                "row_sha256": P.sha(P.encoded(row).rstrip(b"\n")),
                "raw_response_sha256": P.sha(response.encode("utf-8")), **extra}

    def refresh(self):
        inventory, checks, comparisons, recs, source_refs = [], [], [], [], []
        for work in self.work_names:
            prefix = f"runs/fixture/{work}"
            source_rows = [{"sentence_id": sid, "chapter_id": "B001:C0001", "work_id": self.local_work,
                            "text": text, "text_sha256": P.sha(text.encode("utf-8"))}
                           for sid, text in ((SID, "The gate opens. Additional context."),
                                             (SID2, f"Context for {work}, not prior evidence."))]
            if self.duplicate_source:
                source_rows.append({**source_rows[0], "text": "CONFLICTING duplicate source."})
            source = self.rows(prefix + "/sentences.jsonl", source_rows)
            source_refs.append((work, source))
            window = {"window_id": "W000001", "chapter_id": "B001:C0001",
                      "anchor_sentence_ids": [SID], "attached_sentence_ids": [SID2], "role": "rule_atom_read"}
            coverage = self.rows(prefix + "/coverage.jsonl", [window])
            checks.extend([{"work": work, "label": "coverage_partition.jsonl", "matches": True,
                            "path": coverage["path"], "recorded_sha256": coverage["sha256"]},
                           {"work": work, "label": "sentences.jsonl", "matches": True,
                            "matching_paths": [source["path"]], "recorded_sha256": source["sha256"]}])
            card = {"primary_route": "bounded_event", "proposition_text": "The gate opens.",
                    "evidence_ids": [SID], "evidence_spans": [{"sentence_id": SID, "start": 0,
                                                              "end": 9999 if self.invalid_span else 15}],
                    "assertion_status": "narrator_asserted", "temporal_status": "bounded_occurrence",
                    "evidence_directness": "explicit", "content_facets": ["bounded_event"],
                    "generality_scope": "instance", "claimant_or_source": None}
            items = [{"card_id": f"W000001#{i:03d}", "window_id": "W000001", "work_id": work,
                      "chapter_id": "B001:C0001", "normalized_card": copy.deepcopy(card),
                      "generator_card": copy.deepcopy(card), "private_rationale": SECRET}
                     for i in range(self.cards)]
            gen_row = {"window_id": "W000001", "sentence_ids": [SID, SID2], "cards": items,
                       "raw_response": SECRET}
            gen_ref = self.rows(prefix + "/proposition_generator.jsonl", [gen_row])
            job_ref = self.obj(prefix + "/job_record.json", {"book": work,
                "input_artifact_hashes": {"coverage_partition.jsonl": coverage["sha256"],
                                          "sentences.jsonl": source["sha256"]}})
            inventory.extend([source, coverage, gen_ref, job_ref])
            sides = {}
            for side in ("original", "reverify"):
                rows = []
                for i, item in enumerate(items):
                    row = copy.deepcopy(item)
                    v = {"verdict": "contradicted" if side == "original" else "insufficient",
                         "raw_response": SECRET, "private_rationale": SECRET,
                         "checks": [{"field_path": "primary_route", "verdict": "entailed",
                                     "evidence_ids": [SID], "reason": SECRET}], "errors": []}
                    if self.extra_check:
                        v["checks"].append({"field_path": SECRET, "verdict": SECRET,
                                             "evidence_ids": [SECRET], "reason": SECRET})
                    row["verifier"] = v
                    if side == "reverify" and self.mismatch == "candidate":
                        row["normalized_card"]["proposition_text"] = "Something else."
                    if side == "reverify" and self.mismatch == "work":
                        row["work_id"] = "wrong-work"
                    if side == "reverify" and self.mismatch == "window":
                        row["window_id"] = "Wwrong"
                    if side == "reverify" and self.mismatch == "card":
                        row["card_id"] = "wrong-card"
                    if side == "reverify" and self.different_raw:
                        row["verifier"]["raw_response"] = json.dumps({"verdict": "insufficient"}, indent=4)
                    elif self.different_raw:
                        row["verifier"]["raw_response"] = '{"verdict":"contradicted"}'
                    rows.append(row)
                ref = self.rows(prefix + f"/{side}.jsonl", rows)
                inventory.append(ref)
                sides[side] = [{"work": work, "card_id": item["card_id"], "cohort": "wave_a",
                                "window_id": "W000001", "attempt": side,
                                "attempt_artifact": self.loc(ref, i + 1, row, row["verifier"]["raw_response"]),
                                "audited_status": row["verifier"]["verdict"],
                                "recorded_status": row["verifier"]["verdict"],
                                "stored_verdict": row["verifier"]["verdict"], "entailed_flag": False,
                                "stored_errors": [], "independent_error_codes": [], "private_reason": SECRET}
                               for i, (item, row) in enumerate(zip(items, rows))]
            for i, item in enumerate(items):
                comp = {"work": work, "cohort": "wave_a", "card_id": item["card_id"],
                        "status_conflict": True, "original": [sides["original"][i]],
                        "reverify": [sides["reverify"][i]], "precedence": "unresolved"}
                comparisons.append(comp)
                recs.append({**copy.deepcopy(comp), "generator_artifact": self.loc(gen_ref, 1, gen_row, SECRET, card_index=i)})
        if self.duplicate_reconciliation:
            recs.append({**copy.deepcopy(recs[0]), "generator_status": "CONFLICT"})
        if self.duplicate_comparison:
            comparisons.append(copy.deepcopy(comparisons[0]))
        self.rows(P.AUDIT / "card_reconciliation.jsonl", recs)
        refs = [self.obj(P.AUDIT / "manifest.json", {"offline_only": True}),
                self.obj(P.AUDIT / "report.json", {"historical_input_hash_checks": checks}),
                self.rows(P.AUDIT / "input_hashes.jsonl", inventory),
                self.rows(P.AUDIT / "reverify_comparison.jsonl", comparisons)]
        self.pins = {Path(r["path"]).name: r["sha256"] for r in refs}
        self.kwargs = {"pins": self.pins, "expected_rows": len(comparisons), "expected_conflicts": len(comparisons)}
        if self.make_bindings:
            parent = P.IDENTITY.parent
            authorization = self.obj(parent / "authorization.json", {"scope": "fixture_only"})
            records = []
            for work, source in source_refs:
                records.append({"approved": True, "key": {"named_work_id": "wrong" if self.bad_binding_work else work,
                    "full_original_sentence_file_sha256": source["sha256"], "local_work_id": self.local_work}})
            for i in range(83 - len(records)):
                records.append({"approved": True, "key": {"named_work_id": f"unused-{i}",
                    "full_original_sentence_file_sha256": "0" * 64, "local_work_id": "B001"}})
            bindings = self.rows(parent / "approved_bindings.jsonl", records)
            manifest = self.obj(P.IDENTITY, {"counts": {"approved_bindings": 83},
                "outputs": {"authorization.json": authorization, "approved_bindings.jsonl": bindings}})
            self.kwargs["identity_pin"] = manifest["sha256"]

    def compile(self):
        return P.compile_package(self.root, **self.kwargs)

    def cases(self):
        products, _, _ = self.compile()
        return [json.loads(line) for line in products["reviewed_cases.jsonl"].splitlines()]

    def test_complete_real_sized_cohort_not_sample(self):
        self.cards = 713
        self.refresh()
        products, _, manifest = self.compile()
        self.assertEqual(manifest["counts"]["status_conflict_rows"], 713)
        self.assertEqual(manifest["counts"]["status_counts"]["reviewable"], 713)
        self.assertEqual(len(products["reviewed_cases.jsonl"].splitlines()), 713)

    def test_no_model_calls_no_winner_no_expected_answers_or_private_prose(self):
        self.extra_check = True
        self.refresh()
        products, _, manifest = self.compile()
        self.assertNotIn(SECRET.encode(), b"".join(products.values()))
        cases = [json.loads(line) for line in products["reviewed_cases.jsonl"].splitlines()]
        case = cases[0]
        self.assertEqual(case["status"], "reviewable")
        self.assertEqual(case["historical_precedence"], "unresolved_no_automatic_winner")
        self.assertEqual(case["original"][0]["stored_verdict"], "contradicted")
        self.assertNotIn("new_source_judgment", case)
        self.assertNotIn("expected", products["reviewed_cases.jsonl"].decode())
        registration = json.loads(products["executor_registration.json"])
        self.assertIsNone(registration["actual_model"])
        self.assertIsNone(registration["actual_provider"])
        self.assertIsNone(registration["actual_version"])
        self.assertEqual(registration["requested_label"], "gpt6luna")
        self.assertEqual(manifest["model_calls"], 0)
        self.assertFalse(manifest["dispatch_authorized"])
        self.assertEqual(manifest["authorizations_created"], [])

    def test_exact_sent_spans_separate_full_context_and_source_receipts(self):
        case = self.cases()[0]
        span = case["prior_sent_evidence"]["original"][0]["spans"][0]
        self.assertEqual(span["historical_rendered_text"], "The gate opens.")
        self.assertEqual(span["historical_span"], {"sentence_id": SID, "start": 0, "end": 15})
        self.assertEqual(case["new_review_context"][0]["text"], "The gate opens. Additional context.")
        self.assertEqual(span["source_window_ids"], ["W000001"])
        self.assertEqual(span["source_file"]["sha256"], case["source_refs"]["sentences"]["sha256"])
        self.assertEqual(span["current_span_validation"], "valid")

    def test_invalid_historical_span_never_repaired_or_substituted(self):
        self.invalid_span = True
        self.refresh()
        case = self.cases()[0]
        span = case["prior_sent_evidence"]["original"][0]["spans"][0]
        self.assertEqual(span["historical_span"]["end"], 9999)
        self.assertEqual(span["current_span_validation"], "out_of_bounds_or_empty")
        self.assertTrue(span["historical_slicing_not_repaired"])

    def test_same_snapshot_different_raw_json_is_not_candidate_mismatch(self):
        self.different_raw = True
        self.refresh()
        case = self.cases()[0]
        self.assertEqual(case["status"], "reviewable")
        self.assertNotEqual(case["original"][0]["attempt_artifact"]["raw_response_sha256"],
                            case["reverify"][0]["attempt_artifact"]["raw_response_sha256"])

    def test_attempt_candidate_work_window_and_card_mismatch_block(self):
        for field in ("candidate", "work", "window", "card"):
            with self.subTest(field=field):
                self.mismatch = field
                self.refresh()
                case = self.cases()[0]
                self.assertEqual(case["status"], "blocked_integrity")
                self.assertEqual(case["allowed_review_ids"], [])
                self.assertEqual(case["new_review_context"], [])
                self.assertIsNotNone(case["candidate_snapshot"])

    def test_conflicting_duplicate_source_is_metadata_blocked(self):
        self.duplicate_source = True
        self.refresh()
        case = self.cases()[0]
        self.assertEqual(case["status"], "blocked_source")
        self.assertIn("conflicting_duplicate_source_sentence", case["diagnostics"])
        self.assertEqual(case["new_review_context"], [])
        self.assertEqual(case["prior_sent_evidence"]["original"][0]["historical_evidence_spans"],
                         [{"sentence_id": SID, "start": 0, "end": 15}])
        self.assertEqual(case["prior_sent_evidence"]["original"][0]["spans"], [])

    def test_conflicting_duplicate_reconciliation_is_metadata_blocked(self):
        self.duplicate_reconciliation = True
        self.refresh()
        case = self.cases()[0]
        self.assertEqual(case["status"], "blocked_integrity")
        self.assertEqual(len(case["audit_locators"]["reconciliation"]), 2)

    def test_duplicate_comparison_rows_all_retained_once_as_blocked_metadata(self):
        self.duplicate_comparison = True
        self.refresh()
        cases = self.cases()
        self.assertEqual(len(cases), 2)
        self.assertTrue(all(c["status"] == "blocked_integrity" for c in cases))
        self.assertTrue(all(c["allowed_review_ids"] == [] for c in cases))
        self.assertEqual(len({c["case_id"] for c in cases}), 2)
        self.assertEqual(cases[0]["distinct_key"], cases[1]["distinct_key"])

    def test_unresolved_source_and_mutated_attempt_row_block_without_fabrication(self):
        source = self.root / "runs/fixture/fixture-a/sentences.jsonl"
        source.unlink()
        case = self.cases()[0]
        self.assertEqual(case["status"], "blocked_source")
        self.assertEqual(case["new_review_context"], [])
        self.refresh()
        attempt = self.root / "runs/fixture/fixture-a/original.jsonl"
        attempt.write_bytes(attempt.read_bytes().replace(b"The gate opens.", b"The gate shuts.", 1))
        case = self.cases()[0]
        self.assertEqual(case["status"], "blocked_integrity")
        self.assertEqual(case["allowed_review_ids"], [])

    def test_source_index_is_streamed_once_per_file_work_subset(self):
        self.cards = 25
        self.refresh()
        original = P.Inputs.subset
        observed = []
        def record(instance, ref, key, wanted, work):
            if (ref["path"], work, key) not in instance.cache:
                observed.append((ref["path"], work, key))
            return original(instance, ref, key, wanted, work)
        with mock.patch.object(P.Inputs, "subset", record):
            self.compile()
        self.assertEqual(len([key for key in observed if key[2] == "sentence_id"]), 1)

    def test_shards_one_work_and_24_limit_deterministic_every_case_once(self):
        self.cards = 25
        self.work_names = ["fixture-z", "fixture-a"]
        self.refresh()
        products, _, manifest = self.compile()
        shards = json.loads(products["shard_index.json"])
        self.assertEqual([s["case_count"] for s in shards], [24, 1, 24, 1])
        ids = []
        for shard in shards:
            rows = [json.loads(line) for line in products[shard["path"]].splitlines()]
            self.assertEqual({c["work_id"] for c in rows}, {shard["work_id"]})
            ids.extend(c["case_id"] for c in rows)
            self.assertEqual(P.sha(products[shard["path"]]), shard["sha256"])
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(ids), 50)
        self.assertEqual(self.compile()[0], products)
        self.assertEqual(manifest["counts"]["work_count"], 2)

    def test_b001_collision_requires_exact_83_binding_tuple_not_global_alias(self):
        self.local_work = "B001"
        self.work_names = ["fixture-a", "fixture-b"]
        self.make_bindings = True
        self.refresh()
        cases = self.cases()
        self.assertTrue(all(c["status"] == "reviewable" for c in cases))
        a, b = (c["new_review_context"][0]["namespace_binding"]["key"] for c in cases)
        self.assertEqual(a["local_work_id"], b["local_work_id"])
        self.assertNotEqual(a["named_work_id"], b["named_work_id"])
        self.assertNotEqual(a["full_original_sentence_file_sha256"], b["full_original_sentence_file_sha256"])
        self.bad_binding_work = True
        self.refresh()
        self.assertTrue(all(c["status"] == "blocked_source" for c in self.cases()))

    def test_strict_frozen_pin_mutation_no_output(self):
        for name in P.PINS:
            with self.subTest(name=name):
                path = self.audit / name
                before = path.read_bytes()
                path.write_bytes(before + b" ")
                with self.assertRaisesRegex(ValueError, "input_hash_mismatch"):
                    P.prepare(self.root, materialize=True, **self.kwargs)
                self.assertFalse(self.out.exists())
                path.write_bytes(before)

    def test_final_hash_stability_not_mtime_cache(self):
        _, inputs, _ = self.compile()
        path = self.root / "runs/fixture/fixture-a/sentences.jsonl"
        data = path.read_bytes()
        path.write_bytes(data.replace(b"opens", b"close", 1))
        with self.assertRaisesRegex(ValueError, "input_changed_final_hash"):
            inputs.final_check()

    def test_unsafe_paths_rejected(self):
        for value in ("../outside", "runs/../outside", "runs/NUL", "runs/a.", "runs/a:b", "//server/share"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                P.safe_path(self.root, value)

    def test_existing_output_not_overwritten(self):
        self.out.mkdir()
        marker = self.out / "marker"
        marker.write_bytes(b"KEEP")
        with self.assertRaisesRegex(ValueError, "existing_output_forbidden"):
            P.prepare(self.root, materialize=True, **self.kwargs)
        self.assertEqual(marker.read_bytes(), b"KEEP")

    def test_dry_run_then_materialize_then_external_pin_byte_check_no_writes(self):
        dry = P.prepare(self.root, **self.kwargs)
        self.assertFalse(self.out.exists())
        result = P.prepare(self.root, materialize=True, **self.kwargs)
        self.assertEqual(dry["manifest_sha256"], result["manifest_sha256"])
        paths = list(self.root.rglob("*"))
        before = {str(p): (p.read_bytes(), p.stat().st_mtime_ns) for p in paths if p.is_file()}
        checked = P.prepare(self.root, check=True, manifest_sha256=result["manifest_sha256"], **self.kwargs)
        after = {str(p): (p.read_bytes(), p.stat().st_mtime_ns) for p in self.root.rglob("*") if p.is_file()}
        self.assertEqual(before, after)
        self.assertEqual(checked["mode"], "check")
        with self.assertRaisesRegex(ValueError, "external_manifest_pin_required"):
            P.prepare(self.root, check=True, **self.kwargs)
        with self.assertRaisesRegex(ValueError, "manifest_pin_mismatch"):
            P.prepare(self.root, check=True, manifest_sha256="0" * 64, **self.kwargs)
        shard = self.out / "shards/shard_0001.jsonl"
        shard.write_bytes(shard.read_bytes() + b"\n")
        with self.assertRaisesRegex(ValueError, "output_byte_mismatch"):
            P.prepare(self.root, check=True, manifest_sha256=result["manifest_sha256"], **self.kwargs)

    def test_schema_sampler_valid_no_cohort_answer_baseline(self):
        products, _, _ = self.compile()
        sample = json.loads(products["schema_sampler.json"])
        instance = sample["instance"]
        P.validate_response(instance, {"case_id": instance["case_id"], "status": "blocked_source", "allowed_review_ids": []})
        self.assertNotEqual(instance["case_id"], self.cases()[0]["case_id"])
        try:
            import jsonschema
        except ImportError:
            return
        jsonschema.Draft202012Validator.check_schema(sample["schema"])
        jsonschema.validate(instance, sample["schema"])

    def test_response_enforces_actual_executor_citations_and_blocked_abstention(self):
        products, _, _ = self.compile()
        sample = json.loads(products["schema_sampler.json"])["instance"]
        case = self.cases()[0]
        sample["case_id"] = case["case_id"]
        sample["actual_executor"]["model"] = None
        with self.assertRaisesRegex(ValueError, "actual_executor_required"):
            P.validate_response(sample, case)
        sample["actual_executor"]["model"] = "TEST_ONLY"
        sample.update(new_source_judgment="supported", abstain=False, support_scope="new_review_context_only",
                      citations=[{"review_id": "context:0", "sent_vs_context": "context"}])
        P.validate_response(sample, case)
        sample["citations"][0]["review_id"] = "another_case_or_vote"
        with self.assertRaisesRegex(ValueError, "citation_out_of_scope"):
            P.validate_response(sample, case)
        sample["citations"] = []
        sample["support_scope"] = "none"
        case["status"] = "blocked_source"
        with self.assertRaisesRegex(ValueError, "blocked_must_abstain"):
            P.validate_response(sample, case)


if __name__ == "__main__":
    unittest.main()
