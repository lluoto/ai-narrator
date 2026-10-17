"""Fail-closed scheduler evidence, not per-card effective-result selection.

Only v2 reports with explicit completion and complete accounting are successes.
job_record.json supplies input_artifact_hashes; its byte hash binds a selection.
Its output_file_hashes manifest is rechecked against every result artifact.
Callers should supply current input hashes/job fields and a context_sha256 that
also covers runner/config bytes. No root-report or timestamp fallback exists.

Attempts reserve attempts/<uuid>/ and return its absent output/ child so an
absent-only runner can write there. Neither retries nor selection touch old
attempts. A second explicit select_attempt() appends a content-addressed record
with supersedes_sha256, then atomically replaces ONLY selected_attempt.json.
History and failed attempts remain intact. Writers are serialized by an
exclusive selection lock; an interrupted lock requires manual investigation.

Validation brackets two full output SHA passes with tree membership and dev/ino/size/
mtime_ns/ctime_ns observations, including job/report. This is a bounded local
observation, not an adversarial snapshot, filesystem lock, NFS consistency or
power-loss guarantee. Changes after the final observation remain possible.
Failed publication may leave content-addressed orphan history, never a new
selected pointer. File signatures detect change; they never replace SHA checks.
"""

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import uuid


SUCCESS_STATUSES = frozenset({"completed", "no_eligible_windows"})
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
ROUTE_NAMES = (
    "mechanism", "bounded_event", "entity_profile", "relationship_institution",
    "environment_location", "attributed_context", "tactic_context", "source_noise_fragment",
)


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8")


def _parse_object(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result
    def reject_constant(value):
        raise ValueError("nonfinite JSON constant: " + value)
    value = json.loads(data.decode("utf-8"), object_pairs_hook=unique, parse_constant=reject_constant)
    if not isinstance(value, dict):
        raise ValueError("expected JSON object")
    return value


def _tree_snapshot(directory):
    """Observe membership and identities of all directories/files, without caching hashes."""
    entries = {}
    resolved_root = directory.resolve()

    def observe(path):
        if (path.is_symlink() or getattr(path, "is_junction", lambda: False)()
                or path.resolve() != resolved_root / path.relative_to(directory)):
            raise ValueError("symlink output artifact")
        info = path.stat()
        if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            raise ValueError("nonregular output artifact")
        entries[path.relative_to(directory).as_posix()] = (
            stat.S_IFMT(info.st_mode), info.st_dev, info.st_ino, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns,
        )

    def walk_error(exc):
        raise exc

    observe(directory)
    for root, directories, files in os.walk(directory, followlinks=False, onerror=walk_error):
        for name in directories + files:
            observe(Path(root) / name)
    return entries


def _validate_outputs(directory, manifest, *, requested, verified, gen_attempts, reverify):
    """Bind the complete artifact tree, including each successful call capture."""
    if not isinstance(manifest, dict) or directory.is_symlink():
        raise ValueError("missing/invalid output hash manifest")
    excluded = {"job_record.json", "validation_report.json"}
    actual = set()
    resolved_root = directory.resolve()

    def walk_error(exc):
        raise exc

    for root, directories, files in os.walk(directory, followlinks=False, onerror=walk_error):
        for name in directories + files:
            path = Path(root) / name
            if path.is_symlink() or path.resolve() != resolved_root / path.relative_to(directory):
                raise ValueError("symlink output artifact")
        actual.update((Path(root) / name).relative_to(directory).as_posix() for name in files)
    if actual - excluded != set(manifest):
        raise ValueError("output manifest does not cover artifact tree")
    for relative, digest in manifest.items():
        if not isinstance(relative, str) or "\\" in relative or ":" in relative:
            raise ValueError("unsafe output path")
        parts = PurePosixPath(relative).parts
        if (not parts or PurePosixPath(relative).is_absolute()
                or PurePosixPath(relative).as_posix() != relative
                or any(p in {".", ".."} or p.endswith((".", " ")) or any(ord(c) < 32 for c in p) for p in parts)
                or relative in excluded):
            raise ValueError("unsafe output path")
        path = directory.joinpath(*parts)
        if (not isinstance(digest, str) or not SHA256.fullmatch(digest)
                or not path.is_file() or file_sha256(path) != digest):
            raise ValueError("missing/tampered output artifact")
    if requested:
        required = {"proposition_verifier.jsonl", "checkpoint.jsonl", "stage_journal.jsonl", "failures.jsonl"}
        required.update("validated_route_queues/" + name + ".jsonl" for name in ROUTE_NAMES)
        nonempty = {"checkpoint.jsonl", "stage_journal.jsonl"}
        if not reverify:
            required.update({"proposition_generator.jsonl", "audit_sample_manifest.json"})
            nonempty.update({"proposition_generator.jsonl", "audit_sample_manifest.json"})
        if verified:
            nonempty.add("proposition_verifier.jsonl")
        if not required <= manifest.keys() or any((directory / name).stat().st_size == 0 for name in nonempty):
            raise ValueError("required output artifact missing/empty")
    captures = {}
    for relative in manifest:
        if not relative.startswith("calls/"):
            continue
        parts = PurePosixPath(relative).parts
        match = re.fullmatch(r"([0-9]{6,})_(generator|verifier)", parts[1]) if len(parts) == 3 else None
        if match is None or match[1] != f"{int(match[1]):06d}":
            raise ValueError("invalid call capture path")
        captures.setdefault(parts[1], set()).add(parts[2])
    indices = [int(name.split("_", 1)[0]) for name in captures]
    total = gen_attempts + verified
    if (len(indices) != total or any(index != expected for expected, index in enumerate(sorted(indices), 1))
            or sum(name.endswith("_generator") for name in captures) != gen_attempts
            or sum(name.endswith("_verifier") for name in captures) != verified):
        raise ValueError("call capture accounting mismatch")
    for name, files in captures.items():
        required = {"request_body.bin", "response_body.bin", "journal.jsonl"}
        if not required <= files or any((directory / "calls" / name / f).stat().st_size == 0 for f in required):
            raise ValueError("missing/empty call capture")


def validated_report_status(directory, *, expected_job_hash=None, expected_report_hash=None,
                             expected_input_hashes=None, expected_job_fields=None,
                             expected_source_generator_hash=None):
    """Return success, legacy_unvalidated, missing, invalid, or unstable.

    A successful result requires unchanged tree membership and file signatures
    around all metadata reads and full artifact hashing. See the module's bounded
    observation guarantee; callers publishing evidence must bracket publication too.
    """
    directory = Path(directory)
    try:
        if not os.path.lexists(directory):
            return "missing"
        before = _tree_snapshot(directory)
    except FileNotFoundError:
        return "unstable"
    except (OSError, ValueError, RecursionError):
        return "invalid"
    status = _validated_report_status(
        directory, expected_job_hash=expected_job_hash, expected_report_hash=expected_report_hash,
        expected_input_hashes=expected_input_hashes, expected_job_fields=expected_job_fields,
        expected_source_generator_hash=expected_source_generator_hash,
    )
    try:
        if before != _tree_snapshot(directory):
            return "unstable"
    except (OSError, ValueError, RecursionError):
        return "unstable"
    return status


def _validated_report_status(directory, *, expected_job_hash, expected_report_hash,
                             expected_input_hashes, expected_job_fields,
                             expected_source_generator_hash):
    """Parse and hash the same single read of each metadata file.

    Generator accounting: requested == processed == completed; all proposed
    cards are considered, attempted and valid; sum(verdicts) == verified.
    Reverify has the same accounting but zero generator attempts. All counts
    are nonnegative integers, never bools.
    Transport/window/contract/verifier errors must be zero. No-work additionally
    requires every generator count zero and candidate_output_written is False.
    output_file_hashes is mandatory and covers the entire saved artifact tree,
    excluding job/report. Empty manifests are permitted for no-work only.
    """
    directory = Path(directory)
    try:
        if directory.is_symlink() or any((directory / name).is_symlink() for name in ("validation_report.json", "job_record.json")):
            return "invalid"
        report_bytes = (directory / "validation_report.json").read_bytes()
        report_hash = hashlib.sha256(report_bytes).hexdigest()
        report = _parse_object(report_bytes)
        if expected_report_hash is not None and report_hash != expected_report_hash:
            return "invalid"
    except FileNotFoundError:
        return "missing"
    except (OSError, ValueError, RecursionError):
        return "invalid"
    version = report.get("acceptance_contract_version")
    if type(version) is not int or version != 2:
        historical = version is None or (type(version) is int and version < 2)
        return "legacy_unvalidated" if historical and report.get("ok") is True else "invalid"
    try:
        def count(key):
            value = report[key]
            if type(value) is not int or value < 0:
                raise ValueError("invalid count: " + key)
            return value

        status = report.get("status")
        if (report.get("ok") is not True or status not in SUCCESS_STATUSES
                or report.get("generation_complete") is not True
                or report.get("verification_complete") is not True
                or report.get("execution_complete") is not True
                or count("contract_errors") != 0 or count("failures") != 0):
            return "invalid"
        for field in ("window_errors", "windows_unattempted", "generation_errors", "envelope_errors",
                      "cards_schema_or_span_rejected", "verifier_contract_errors", "source_binding_errors",
                      "cards_unusable", "cards_unattempted"):
            if count(field) != 0:
                return "invalid"
        if (report.get("unattempted_window_ids") != [] or report.get("unattempted_card_ids") != []
                or "terminal_failure" not in report or report["terminal_failure"] is not None):
            return "invalid"
        errors = report["verifier_error_counts"]
        verdicts = report["verdicts"]
        if not isinstance(errors, dict) or not isinstance(verdicts, dict):
            return "invalid"
        if any(type(v) is not int or v != 0 for v in errors.values()):
            return "invalid"
        if any(type(v) is not int or v < 0 for v in verdicts.values()):
            return "invalid"
        if set(verdicts) - {"entailed", "insufficient", "contradicted", "insufficient_evidence", "abstain"}:
            return "invalid"
        verified = count("cards_verified")
        if (sum(verdicts.values()) != verified
                or any(count(key) != verified for key in ("cards_valid", "cards_considered", "proposer_cards", "verifier_attempts"))):
            return "invalid"
        reverify = report.get("mode") == "verifier_only_reverify"
        requested = count("windows_requested")
        if count("windows_processed") != requested or count("windows_completed") != requested:
            return "invalid"
        gen_attempts = count("generator_attempts")
        if gen_attempts != (0 if reverify else requested) or count("total_calls") != gen_attempts + verified:
            return "invalid"
        if status == "no_eligible_windows":
            if requested != 0 or verified != 0 or report.get("candidate_output_written") is not False:
                return "invalid"
        elif requested == 0:
            return "invalid"
        job_bytes = (directory / "job_record.json").read_bytes()
        job_hash = hashlib.sha256(job_bytes).hexdigest()
        job = _parse_object(job_bytes)
        if (type(job.get("acceptance_contract_version")) is not int
                or job["acceptance_contract_version"] != 2 or job.get("status") != status):
            return "invalid"
        hashes = job["input_artifact_hashes"]
        if not isinstance(hashes, dict) or not hashes:
            return "invalid"
        if any(not isinstance(v, str) or not SHA256.fullmatch(v) for v in hashes.values()):
            return "invalid"
        if expected_job_hash is not None and job_hash != expected_job_hash:
            return "invalid"
        if expected_input_hashes is not None and hashes != expected_input_hashes:
            return "invalid"
        if expected_job_fields and any(job.get(k) != v for k, v in expected_job_fields.items()):
            return "invalid"
        if reverify:
            source_hash = report.get("source_generator_jsonl_sha256")
            if (not isinstance(source_hash, str) or not SHA256.fullmatch(source_hash)
                    or job.get("generator_jsonl_sha256") != source_hash):
                return "invalid"
        if expected_source_generator_hash is not None:
            if not reverify or source_hash != expected_source_generator_hash:
                return "invalid"
        _validate_outputs(directory, job["output_file_hashes"], requested=requested,
                          verified=verified, gen_attempts=gen_attempts, reverify=reverify)
        # Windows ctime may be creation time; restored mtime must not mask a
        # rewrite of an artifact already hashed in the first pass.
        try:
            for relative, digest in job["output_file_hashes"].items():
                if file_sha256(directory / relative) != digest:
                    return "unstable"
        except OSError:
            return "unstable"
        return status
    except (OSError, ValueError, KeyError, TypeError, RecursionError):
        return "invalid"


def allocate_attempt(scope):
    """Reserve a new namespace; never remove or reuse any existing path."""
    scope = Path(scope)
    if scope.is_symlink():
        raise ValueError("symlink scope")
    attempts = scope / "attempts"
    attempts.mkdir(parents=True, exist_ok=True)
    if attempts.is_symlink() or attempts.resolve().parent != scope.resolve():
        raise ValueError("unsafe attempts directory")
    reservation = attempts / uuid.uuid4().hex
    reservation.mkdir()  # exclusive, including on a UUID collision
    return reservation / "output"


def _attempt_path(scope, relative):
    if scope.is_symlink():
        raise ValueError("symlink scope")
    if not isinstance(relative, str) or "\\" in relative or ":" in relative:
        raise ValueError("unsafe selected path")
    parts = PurePosixPath(relative).parts
    if (len(parts) != 3 or parts[0] != "attempts" or parts[2] != "output"
            or not re.fullmatch(r"[0-9a-f]{32}", parts[1])
            or PurePosixPath(relative).as_posix() != relative):
        raise ValueError("unsafe attempt id")
    target = scope.joinpath(*parts)
    for part in (scope / "attempts", target.parent, target):
        if part.is_symlink():
            raise ValueError("symlink attempt")
    if not target.is_dir() or target.resolve().parent.parent.parent != scope.resolve():
        raise ValueError("missing/outside attempt")
    if any((target / name).is_symlink() for name in ("validation_report.json", "job_record.json")):
        raise ValueError("symlink evidence")
    return target


def _selection(scope):
    pointer = scope / "selected_attempt.json"
    if pointer.is_symlink():
        raise ValueError("symlink pointer")
    payload = pointer.read_bytes()
    record = _parse_object(payload)
    digest = hashlib.sha256(payload).hexdigest()
    history = scope / "selection_history"
    if history.is_symlink():
        raise ValueError("symlink history")
    seen = set()
    current = digest
    while current is not None:
        if not isinstance(current, str) or not SHA256.fullmatch(current) or current in seen:
            raise ValueError("invalid selection history")
        seen.add(current)
        path = history / (current + ".json")
        if path.is_symlink():
            raise ValueError("selection history mismatch")
        payload = path.read_bytes()
        if hashlib.sha256(payload).hexdigest() != current:
            raise ValueError("selection history mismatch")
        item = _parse_object(payload)
        if (type(item.get("selection_version")) is not int or item["selection_version"] != 1
                or item.get("purpose") not in {"generator", "reverify"}):
            raise ValueError("invalid selection record")
        for key in ("validation_report_sha256", "job_record_sha256"):
            if not isinstance(item.get(key), str) or not SHA256.fullmatch(item[key]):
                raise ValueError("invalid selection hash")
        context = item["context_sha256"]
        if context is not None and (not isinstance(context, str) or not SHA256.fullmatch(context)):
            raise ValueError("invalid selection context")
        _attempt_path(scope, item["selected_path"])
        if current == digest and item != record:
            raise ValueError("selection mismatch")
        current = item["supersedes_sha256"]
    return record, digest


def selection_integrity_status(scope, *, purpose=None):
    """Return absent/intact/broken independently of current source/config context.

    Intact means a well-formed hash chain and unchanged bound report/job bytes,
    not accepted completion. A stale intact selection may be explicitly
    superseded. Broken pointers/history require review before any new work.
    """
    scope = Path(scope)
    try:
        if scope.is_symlink() or os.path.lexists(scope / ".selection.lock"):
            return "broken"
        if not os.path.lexists(scope / "selected_attempt.json"):
            history = scope / "selection_history"
            if os.path.lexists(history) and (history.is_symlink() or not history.is_dir() or any(history.iterdir())):
                return "broken"
            return "absent"
        record, _ = _selection(scope)
        if purpose is not None and record["purpose"] != purpose:
            return "broken"
        target = _attempt_path(scope, record["selected_path"])
        if (file_sha256(target / "validation_report.json") != record["validation_report_sha256"]
                or file_sha256(target / "job_record.json") != record["job_record_sha256"]):
            return "broken"
        return "intact"
    except (OSError, ValueError, KeyError, TypeError, RecursionError):
        return "broken"


def selected_attempt(scope, *, context_sha256=None, purpose="generator", **expected):
    """Resolve ONLY an intact explicit selection. Invalid/absent means None."""
    scope = Path(scope)
    try:
        record, _ = _selection(scope)
        if record["purpose"] != purpose:
            return None
        if context_sha256 is not None and record.get("context_sha256") != context_sha256:
            return None
        target = _attempt_path(scope, record["selected_path"])
        before = _tree_snapshot(target)
        report_bytes = (target / "validation_report.json").read_bytes()
        if hashlib.sha256(report_bytes).hexdigest() != record["validation_report_sha256"]:
            return None
        if (_parse_object(report_bytes).get("mode") == "verifier_only_reverify") != (purpose == "reverify"):
            return None
        expected = dict(expected)
        for argument, field in (("expected_job_hash", "job_record_sha256"),
                                ("expected_report_hash", "validation_report_sha256")):
            if argument in expected and expected[argument] != record[field]:
                return None
            expected[argument] = record[field]
        if validated_report_status(target, **expected) not in SUCCESS_STATUSES:
            return None
        if (file_sha256(target / "validation_report.json") != record["validation_report_sha256"]
                or file_sha256(target / "job_record.json") != record["job_record_sha256"]
                or before != _tree_snapshot(target)):
            return None
        return target
    except (OSError, ValueError, KeyError, TypeError, RecursionError):
        return None


def select_attempt(scope, attempt, *, context_sha256=None, purpose="generator", **expected):
    """Explicit bookkeeping selection, never automatic reverify precedence."""
    scope = Path(scope)
    attempt = Path(attempt)
    relative = attempt.relative_to(scope).as_posix()
    target = _attempt_path(scope, relative)
    if purpose not in {"generator", "reverify"}:
        raise ValueError("invalid selection purpose")
    if context_sha256 is not None and (not isinstance(context_sha256, str) or not SHA256.fullmatch(context_sha256)):
        raise ValueError("invalid selection context")
    lock = scope / ".selection.lock"
    with open(lock, "x", encoding="utf-8"):
        pass
    temporary = None
    try:
        before = _tree_snapshot(target)
        report_bytes = (target / "validation_report.json").read_bytes()
        job_bytes = (target / "job_record.json").read_bytes()
        pins = {"expected_report_hash": hashlib.sha256(report_bytes).hexdigest(),
                "expected_job_hash": hashlib.sha256(job_bytes).hexdigest()}
        expected = dict(expected)
        for argument, digest in pins.items():
            if argument in expected and expected[argument] != digest:
                raise ValueError("selection hash mismatch")
            expected[argument] = digest
        if validated_report_status(target, **expected) not in SUCCESS_STATUSES:
            raise ValueError("refusing invalid/unstable attempt")
        if (_parse_object(report_bytes).get("mode") == "verifier_only_reverify") != (purpose == "reverify"):
            raise ValueError("selection purpose mismatch")
        previous = None
        if os.path.lexists(scope / "selected_attempt.json"):
            _, previous = _selection(scope)  # never silently repair a broken pointer
        record = {
            "selection_version": 1, "purpose": purpose, "selected_path": relative,
            "validation_report_sha256": pins["expected_report_hash"],
            "job_record_sha256": pins["expected_job_hash"],
            "context_sha256": context_sha256, "supersedes_sha256": previous,
        }
        payload = json_bytes(record)
        digest = hashlib.sha256(payload).hexdigest()
        history = scope / "selection_history"
        history.mkdir(exist_ok=True)
        if history.is_symlink():
            raise ValueError("symlink history")
        with open(history / (digest + ".json"), "xb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        temporary = scope / (".selection-" + uuid.uuid4().hex + ".json")
        with open(temporary, "xb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        if (file_sha256(target / "validation_report.json") != pins["expected_report_hash"]
                or file_sha256(target / "job_record.json") != pins["expected_job_hash"]
                or before != _tree_snapshot(target)):
            raise ValueError("refusing changed attempt before publication")
        os.replace(temporary, scope / "selected_attempt.json")
        return record
    except RecursionError as exc:
        raise ValueError("invalid deeply nested selection JSON") from exc
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
        lock.unlink()
