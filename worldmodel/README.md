# Worldmodel Backup

This subtree is a partial backup of selected worldmodel source code, synthetic
tests, policies, prompts, and metadata-only audit reports. It is included with
this project for reference and recovery, not as a standalone deployment.

It is not the source corpus, including novels or other raw source material. It
is not a store of raw model completions, and it is not runtime authority for
this POC. The POC's code, configured runtime inputs, and applicable reviewed
artifacts remain authoritative.

The latest checkpoint includes acceptance-v2 runner hardening, immutable attempt
selection, approved-identity helpers, duplicate-source materialization tools,
literal/compact experiments, sequential-release protocol, and the independent
final Luna review audit. The Luna review contains 713 structurally accepted
reviewed cases, 705 top-level supported judgments including 29 with dimension
limitations, and 713 undecided historical recommendations. No effective verdict
selection or runtime approval is implied. The historical audit retains an old
summary error rather than presenting the whole history as green.

Private source snapshots, derived source files and occurrence lineage, approved
binding indexes, raw responses, source-bearing Luna packets/verdicts, and review
queues are intentionally absent. Several tests and audit reconstruction commands
require those external datasets or frozen manifests. Synthetic-only tests may be
usable without them, but the full suite is not claimed runnable from this partial
backup. Paths and recorded hashes preserve the original workspace layout.

`BACKUP_MANIFEST.json` records each copied file's original worldmodel-relative
path and source-byte SHA-256. Run `node worldmodel/verify-backup.mjs` to verify
the copied files against that manifest. Subtree attributes disable Git newline
normalization so the copied byte hashes survive checkout. Inclusion of Python
tools here is scoped and does not unignore the application's own tools directory.
