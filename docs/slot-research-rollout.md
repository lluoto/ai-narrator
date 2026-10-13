# Slot Research Rollout

## Scope

This is an opt-in, read-only release of `GET /api/slot-research?workId=<exact-work-id>`. It has no `GameSession`, state, rules, SQLite, or promotion capability. It does not load into runtime world-model wiring or return source/proposal/verdict prose.

The current immutable worldmodel artifacts are the 79-row 2026-09-24 manifest and its complete 85-binding index:

| Pin | Value |
| --- | --- |
| Manifest | `D:\aitrpg\世界模型\worldmodel\runs\_extraction_scheduler\20260924\slot_batch_v4_8001_reviewed_slot_research_manifest_v1\reviewed_slot_research_manifest_v1.jsonl` |
| Manifest SHA-256 | `12786a785aec23e396705996c473713716f3f5957e491019a08a852a4560ed94` |
| Binding index | `D:\aitrpg\世界模型\worldmodel\runs\_extraction_scheduler\20260924\slot_batch_v4_8001_reviewed_slot_research_manifest_v1\poc_artifact_binding_index_v1\reviewed_slot_research_artifact_binding_index_v1.json` |
| Binding-index SHA-256 | `d74c7fd4587d6bd5950ad10ceca8ca8c3886feb88216c71cecd8bf5f3d2aeaee` |

## Process-Local PowerShell Template

Run in the PowerShell that will launch the existing host. This sets exactly five process-local variables; it does not write `.env`, persist user/machine variables, or start a server.

```powershell
$env:SLOT_RESEARCH_MANIFEST_PATH = "D:\aitrpg\世界模型\worldmodel\runs\_extraction_scheduler\20260924\slot_batch_v4_8001_reviewed_slot_research_manifest_v1\reviewed_slot_research_manifest_v1.jsonl"
$env:SLOT_RESEARCH_MANIFEST_SHA256 = "12786a785aec23e396705996c473713716f3f5957e491019a08a852a4560ed94"
$env:SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_PATH = "D:\aitrpg\世界模型\worldmodel\runs\_extraction_scheduler\20260924\slot_batch_v4_8001_reviewed_slot_research_manifest_v1\poc_artifact_binding_index_v1\reviewed_slot_research_artifact_binding_index_v1.json"
$env:SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_SHA256 = "d74c7fd4587d6bd5950ad10ceca8ca8c3886feb88216c71cecd8bf5f3d2aeaee"
$env:SLOT_RESEARCH_ALLOWED_REVIEWER_CLASSES = "lead_model"

if ((Get-FileHash -Algorithm SHA256 $env:SLOT_RESEARCH_MANIFEST_PATH).Hash.ToLowerInvariant() -ne $env:SLOT_RESEARCH_MANIFEST_SHA256) { throw "Manifest pin mismatch" }
if ((Get-FileHash -Algorithm SHA256 $env:SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_PATH).Hash.ToLowerInvariant() -ne $env:SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_SHA256) { throw "Binding-index pin mismatch" }

# Do not start a server here. Use the normal host launcher from this process after the pin checks pass.
```

The handler captures process environment during initialization. Restart the host after any variable change; changing this shell does not reconfigure an already-running process.

## GET Smoke

The pinned manifest contains exactly these work IDs: `异常生物见闻录_远瞳`, `黎明之剑`, and `疯巫妖的实验日志`. Against the restarted opt-in host, make no request body and use no query parameter other than one exact `workId`.

```powershell
$ApiBase = "http://127.0.0.1:<port>" # Existing host only; replace <port>.
$workIds = @("异常生物见闻录_远瞳", "黎明之剑", "疯巫妖的实验日志")

function Assert-Keys([object] $Object, [string[]] $Expected) {
  $actual = @($Object.PSObject.Properties.Name | Sort-Object)
  $expectedKeys = @($Expected | Sort-Object)
  if (@(Compare-Object -ReferenceObject $expectedKeys -DifferenceObject $actual).Count) { throw "Unexpected response fields" }
}

function Invoke-SlotResearchSmoke([string] $WorkId, [string] $ReviewerClass) {
  $uri = "$ApiBase/api/slot-research?workId=$([uri]::EscapeDataString($WorkId))"
  $response = Invoke-RestMethod -Method GET -Uri $uri
  Assert-Keys $response @("status", "receipts")
  Assert-Keys $response.status @("readOnly", "noRuntimeEffect", "admittedReviewerClasses")
  if ($response.status.readOnly -ne $true -or $response.status.noRuntimeEffect -ne $true) { throw "Not read-only metadata" }
  if (@($response.status.admittedReviewerClasses).Count -ne 1 -or $response.status.admittedReviewerClasses[0] -cne $ReviewerClass) { throw "Unexpected reviewer allowlist" }

  foreach ($receipt in @($response.receipts)) {
    Assert-Keys $receipt @("proposal", "verifier", "leadDossier", "sourceParentHashes", "workSource", "route", "reviewerClass", "warnings", "modalityScope")
    Assert-Keys $receipt.proposal @("id", "recordSha256", "recordsFileSha256")
    Assert-Keys $receipt.verifier @("caseId", "canonicalVerdictSha256")
    Assert-Keys $receipt.leadDossier @("id", "lineSha256", "fileSha256")
    Assert-Keys $receipt.sourceParentHashes @("parentBatchManifestSha256", "sourcePropositionRecordsSha256", "sourceSentencesSha256")
    Assert-Keys $receipt.workSource @("workId", "sourceUnitId", "sourceEvidenceId")
    Assert-Keys $receipt.modalityScope @("assertionStatus", "claimantOrSource", "claimantStatus", "temporalStatus", "evidenceDirectness", "sourcePropositionExtractable", "generalityScope", "generalityCueSpan")
    if ($receipt.workSource.workId -cne $WorkId -or $receipt.reviewerClass -cne "lead_model") { throw "Wrong receipt scope" }
  }

  $json = $response | ConvertTo-Json -Depth 8 -Compress
  if ($json -match "raw_model_content|rewrite_payload|raw_source_prose|source_sentence|lead_rationale|canonical_verdict") { throw "Prose payload exposed" }
  [pscustomobject]@{ WorkId = $WorkId; Count = @($response.receipts).Count }
}

$smokes = @($workIds | ForEach-Object { Invoke-SlotResearchSmoke $_ "lead_model" })
if (($smokes | Measure-Object -Property Count -Sum).Sum -ne 79 -or @($smokes | Where-Object Count -eq 0).Count) { throw "Expected 79 receipts across all three work IDs" }
$smokes | Format-Table -AutoSize
```

`POST`, `PUT`, `PATCH`, and `DELETE` are not smoke requests: the endpoint must reject them with `405` and `Allow: GET`.

## Deny-Side Allowlist Smoke

Set only the reviewer allowlist to `human`, restart the existing host so it inherits the changed process environment, then rerun the same GET-only checks. All current rows are `lead_model`, so every request must return `200`, read-only metadata, `admittedReviewerClasses: ["human"]`, and an empty `receipts` list.

```powershell
$env:SLOT_RESEARCH_ALLOWED_REVIEWER_CLASSES = "human"
# Restart the existing host by its normal managed-process procedure; do not launch it from this runbook.
$humanSmokes = @($workIds | ForEach-Object { Invoke-SlotResearchSmoke $_ "human" })
if (($humanSmokes | Measure-Object -Property Count -Sum).Sum -ne 0) { throw "human allowlist admitted a lead_model receipt" }

# Restore the release allowlist and restart the existing host again before normal use.
$env:SLOT_RESEARCH_ALLOWED_REVIEWER_CLASSES = "lead_model"
```

## Rollback And Repin

To disable the facade, stop the existing host, unset all five variables in its launch PowerShell, then restart it. The first GET after restart must return `503` with `SLOT_RESEARCH_UNAVAILABLE`.

```powershell
"SLOT_RESEARCH_MANIFEST_PATH", "SLOT_RESEARCH_MANIFEST_SHA256", "SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_PATH", "SLOT_RESEARCH_ARTIFACT_BINDING_INDEX_SHA256", "SLOT_RESEARCH_ALLOWED_REVIEWER_CLASSES" |
  ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
```

If the manifest, index, or any index-bound artifact changes, do not reuse either pin or alter one pin alone. Build and verify a complete new binding index whose `manifest_sha256` matches the new manifest, calculate both complete-file SHA-256 values, update the four artifact path/hash variables together, update the work-ID/count expectations above, and repeat lead-model plus human-deny smoke after restart.
