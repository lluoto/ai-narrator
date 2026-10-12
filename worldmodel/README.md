# Worldmodel Backup

This subtree is a partial backup of selected worldmodel source code, policies,
and prompts. It is included with this project for reference and recovery.

It is not the source corpus, including novels or other raw source material. It
is not a store of raw model completions, and it is not runtime authority for
this POC. The POC's code, configured runtime inputs, and applicable reviewed
artifacts remain authoritative.

`BACKUP_MANIFEST.json` records each copied file's original worldmodel-relative
path and source-byte SHA-256. Run `node worldmodel/verify-backup.mjs` to verify
the copied files against that manifest.
