# Source Resolution Decision Request

## Completed Deterministic Work

These audits make no source corrections and grant no dispatch permission.

Namespace evidence:

```text
runs/_extraction_scheduler/20260924/source_namespace_binding_audit_v2/
manifest SHA256: 479bb2e590e9c6d3a96dd320a547052beb06c00c45e4a038b335413a978ca04d
```

Duplicate-ID evidence:

```text
runs/_extraction_scheduler/20260924/duplicate_sentence_id_audit_v1/
manifest SHA256: 4bd17418e441a620395e2f1c56812c16cb9dfa406b7d7a59cdb0aacc7abe3e33
```

Paths are relative to `D:\aitrpg\世界模型\worldmodel`. V1 namespace evidence
remains sealed; V2 fixes nearest-source metadata scope and supersedes diagnostics
only, without changing actual counts.

## Namespace Outcome

The 84 pinned sentence snapshots contain 5,390,957 rows. Observed work IDs are
locally `B001`; this is identifier distribution, not a global code/title mapping.
The 160 explicitly pinned metadata files establish no qualifying exact
code/title/source-snapshot relationship.

```text
83 works / 2186 windows: mapping_candidate_needs_approval
1 work / 47 windows: unresolved
0 supported mappings applied
2233 windows remain deferred
```

The unresolved work is `网游之射破苍穹`, whose explicit metadata contains a
malformed record. Duplicate-row identity does not fix that separate issue.

### Decision A: Work-Local Identity Binding

Choose either:

1. Continue locating historical upstream book/source declarations. Keep the
   candidate mappings deferred until exact supporting provenance is found.
2. Explicitly approve a bounded DATA-IDENTITY declaration for reviewed proposed
   entries: `(named_work_id, exact source_file_sha256, local_work_id=B001)`.
   Record authority, evidence hashes and rationale in a new immutable sidecar.
   This declaration is a new approval, not a recovered historical fact.

Never approve `B001 -> title` globally. The same local code in another source
snapshot is a different binding. An approval grants neither proposition truth,
runtime authority, cross-work transfer nor Qwen budget. Consumers need a separate
tested binding-aware validation path; the current strict core is not relaxed
automatically. Do not rewrite existing sentence rows or their original hashes.

## Duplicate Outcome

The full pinned `网游之射破苍穹` sentence file contains:

```text
99683 physical valid rows
71258 distinct sentence IDs
28425 duplicate-ID groups, each exactly two byte-identical rows
0 conflicting or merely JSON-equivalent-but-byte-different groups
```

The 38 ambiguous windows reference 153 of those duplicate groups. All original
locations, hashes and multiplicities are preserved in the audit sidecar. The
remaining 28,272 groups are outside those 38 windows.

### Decision B: Derived Deduplicated Snapshot

If explicitly approved, create a NEW source snapshot with a deterministic
byte-identical-row deduplication rule and a lineage manifest mapping every
original occurrence to its derived record. Preserve all original files and
offset/span text. A changed source-file hash must receive a new binding; it
cannot masquerade as the original generation snapshot.

No survivor or derived snapshot is selected by this report. Conflicting full
records, if any appear in a future input, must fail rather than first/last-win.
Namespace approval and malformed metadata treatment remain separate decisions.

## What Can Be Delegated

Hash validation, identifier distribution, exact duplicate classification and
sidecar preparation are deterministic code tasks and require no model. The
audits above already performed those tasks. A reviewer may inspect proposed
data-identity declarations, but model agreement is not historical source proof.
Natural-language same-book judgments, true proposition quality or conflicting
original/reverify judgments remain separate, with bulk semantic work assigned
to Luna.

## Still Not Done

No bindings are approved/applied. No deduplicated snapshot is created. No deferred
window is released. The existing generation inventory remains 983 resolved
candidate windows and 2233 deferred windows until approved resolutions and a
new inventory explicitly supersede it. No Qwen requests or process operations
were performed.
