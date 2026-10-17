# Approved Source Identity V1

83 exact bindings / 83 original source files / 2186 deferred windows. One unresolved work (47 windows) is excluded. No automatic regeneration or release.

Authorization is a new user-approved data identity declaration, not recovery of historical mapping, human source review, human gold, tier/publication approval, or dispatch authority. The original approved=false proposals remain unchanged.

## Consumer API

`from tools.approved_source_identity import load_approved_bindings, validate_local_identity`

`bindings = load_approved_bindings(manifest_path, manifest_sha256)` requires an external full manifest SHA256. It verifies schema, authorization, all output pins, original pinned evidence and current original source bytes, with final full rehash and metadata stability. The returned mapping and every nested record are read-only (lists become tuples). `verify_sources=False` explicitly skips current source checks, for metadata-only inspection; it must not be used as a current source integrity attestation.

`validate_local_identity(bindings, work_id=title, source_sha256=full_original_file_hash, local_work_id='B001')` returns True only for the exact tuple, otherwise raises ValueError. It performs no I/O and does not rewrite the source record. Consumers must bind the hash to the actual file they read; a loaded map is a point-in-time check, not a live file lock.

## Schema

See `binding_schema.json`. Key order: `(named_work_id, full_original_sentence_file_sha256, local_work_id)`. `source` pins the complete original sentence file; `artifacts` pins coverage/generator/job. `namespace_evidence` contains manifest pins, exact JSONL line/hash, proposal/metadata JSON pointers and metadata pins. `authorization` links each binding to the immutable declaration. The manifest pins all products, including authorization and schema, but has no self-hash.

No global B001 alias, title normalization, path search, silent source fallback, source copy, or generated model output exists here. A derived or deduplicated source SHA256 is not automatically covered, even if its title/local ID is identical. This helper is separate from the unchanged strict core; integration must explicitly opt into this source scope.
