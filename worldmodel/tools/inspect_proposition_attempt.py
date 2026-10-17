"""Read-only, offline postflight observation of one explicit attempt output."""

import argparse
import json
from pathlib import Path
import sys

if __name__ == "__main__":
    sys.dont_write_bytecode = True

if __package__:
    from .proposition_attempts import file_sha256, validated_report_status
else:
    from proposition_attempts import file_sha256, validated_report_status


COUNT_FIELDS = (
    "windows_requested", "windows_processed", "windows_completed", "windows_unattempted",
    "window_errors", "proposer_cards", "cards_considered", "cards_verified", "cards_valid",
    "cards_schema_or_span_rejected", "cards_unusable", "cards_unattempted",
    "generator_attempts", "verifier_attempts", "generation_errors", "envelope_errors",
    "verifier_contract_errors", "source_binding_errors", "contract_errors", "failures", "total_calls",
)
COMPLETION_FIELDS = (
    "ok", "generation_complete", "verification_complete", "execution_complete", "candidate_output_written",
)
SUCCESS_STATES = {"completed", "no_eligible_windows"}
IN_PROGRESS = {"not_started", "pending", "running", "incomplete"}
METADATA_FILES = ("job_record.json", "validation_report.json")


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate metadata key")
        value[key] = item
    return value


def _snapshot(directory):
    """Read only the two metadata files; bind parsing to their byte hashes."""
    objects, hashes, signatures = (dict.fromkeys(METADATA_FILES) for _ in range(3))
    unstable = False
    for name in METADATA_FILES:
        path = directory / name
        objects[name] = hashes[name] = signatures[name] = None
        try:
            if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
                return objects, hashes, signatures, True, True
            before = path.stat()
            hashes[name] = file_sha256(path)
            value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_unique_object)
            after = path.stat()
            signatures[name] = (after.st_dev, after.st_ino, after.st_size,
                                after.st_mtime_ns, after.st_ctime_ns)
            if (before != after or hashes[name] != file_sha256(path)
                    or not isinstance(value, dict)):
                unstable = True
            else:
                objects[name] = value
        except FileNotFoundError:
            unstable |= hashes[name] is not None
        except (OSError, ValueError, UnicodeError, RecursionError):
            unstable = True
    return objects, hashes, signatures, unstable, False


def inspect_attempt(attempt):
    result = {
        "observed_state": "invalid", "acceptance_version": None,
        "scope": {}, "work": {}, "completion_flags": dict.fromkeys(COMPLETION_FIELDS),
        "counts": {}, "strict_validator_status": "not_run", "metadata_stable": None,
        "job_record_sha256": None, "validation_report_sha256": None,
        "quality_certified": False, "no_runtime_effect": True, "read_only": True,
    }
    try:
        directory = Path(attempt)
        # Reject network/device paths before any filesystem access.
        if (not directory.is_absolute() or "\x00" in str(attempt)
                or str(attempt).startswith(("\\\\", "//"))):
            return result
        if (directory.is_symlink() or getattr(directory, "is_junction", lambda: False)()
                or directory.resolve() != directory.absolute()):
            return result
        if not directory.exists():
            result["observed_state"] = "pending" if directory.exists() else "not_started"
            return result
        if not directory.is_dir():
            return result
        before = _snapshot(directory)
        objects, hashes, _, unstable, unsafe = before
        job = objects["job_record.json"]
        report = objects["validation_report.json"]
        strict = "not_run"
        status = report.get("status") if report is not None else None
        job_status = job.get("status") if job is not None else None
        job_in_progress = isinstance(job_status, str) and job_status in IN_PROGRESS
        terminal = (report is not None and (
            (isinstance(status, str) and status not in IN_PROGRESS)
            or (status is None and type(report.get("ok")) is bool)))
        if terminal and not job_in_progress and not unstable and not unsafe:
            strict = validated_report_status(
                directory, expected_job_hash=hashes["job_record.json"],
                expected_report_hash=hashes["validation_report.json"],
            )
        after = _snapshot(directory)
        result["job_record_sha256"] = after[1]["job_record.json"]
        result["validation_report_sha256"] = after[1]["validation_report.json"]
        if unsafe or after[4]:
            return result
        if unstable or after[3] or before != after or strict == "unstable":
            result.update(observed_state="pending", strict_validator_status="unstable", metadata_stable=False)
            return result
        result.update(observed_state="pending", strict_validator_status=strict, metadata_stable=True)
        job, report = job or {}, report or {}
        version = (report if objects["validation_report.json"] is not None else job).get("acceptance_contract_version")
        result["acceptance_version"] = version if type(version) is int else None
        result["scope"] = {key: job[key] for key in ("job_id", "book") if isinstance(job.get(key), str)}
        if isinstance(job.get("roles"), list) and all(isinstance(role, str) for role in job["roles"]):
            result["scope"]["roles"] = job["roles"]
        result["work"] = {key: job[key] for key in ("execution_mode", "generator_profile")
                          if isinstance(job.get(key), str)}
        if isinstance(report.get("mode"), str):
            result["work"]["mode"] = report["mode"]
        if job_in_progress:
            return result
        result["completion_flags"] = {key: report[key] if type(report.get(key)) is bool else None
                                      for key in COMPLETION_FIELDS}
        result["counts"] = {key: report[key] for key in COUNT_FIELDS
                            if type(report.get(key)) is int and report[key] >= 0}
        if terminal:
            if (type(version) is int and version == 2
                    and (type(job.get("acceptance_contract_version")) is not int
                         or job["acceptance_contract_version"] != 2 or job_status != status)):
                result["observed_state"] = "invalid"
            elif type(version) is int and version == 2 and status == "failed":
                result["observed_state"] = "failed"
            elif strict == "legacy_unvalidated":
                result["observed_state"] = "legacy_unvalidated"
            elif strict in SUCCESS_STATES and strict == status and objects["job_record.json"] is not None:
                result["observed_state"] = strict
            else:
                result["observed_state"] = "invalid"
        return result
    except (OSError, ValueError, UnicodeError, RecursionError):
        result.update(observed_state="pending", strict_validator_status="unstable", metadata_stable=False)
        return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=(
        "Read-only offline postflight for one absolute attempt output directory. "
        "Reads job/report metadata only, except terminal reports invoke the shared strict output-hash validator. "
        "Prints JSON without source content or raw evidence; never certifies quality or changes runtime state. "
        "Exit codes: 0 = strict completed/no_eligible_windows; 3 = pending/not_started (including unstable metadata); "
        "1 = failed/invalid/legacy_unvalidated (including invalid paths); 2 = argument usage error."
    ))
    parser.add_argument("--attempt", required=True, help="Absolute attempt output directory; absence is not_started.")
    args = parser.parse_args(argv)
    result = inspect_attempt(args.attempt)
    print(json.dumps(result, sort_keys=True, ensure_ascii=True, allow_nan=False))
    if result["observed_state"] in SUCCESS_STATES:
        return 0
    return 3 if result["observed_state"] in {"pending", "not_started"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
