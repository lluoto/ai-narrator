// 生成 docs/now.md —— 每个会话**第一件事**读它，30 秒进入状态。
//
// 为什么要有：上下文被 compact 之后重新起步，如果只有一堆散文档，
// 得读半天才知道「现在在哪、手上是什么、下一步是什么」。
// 这份文件短到能整读，且大部分字段是脚本自动填的，不会跟代码脱节。
//
// 用法：bun scripts/now.ts            刷新（读 git + 测试数）
//       bun scripts/now.ts --no-test  跳过跑测试（快）

import { readFileSync, writeFileSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import { boundedBunFailureDiagnostics, judgeProcess, type TestBaseline } from "../src/diagnostics/source-scan";
import { collectTestRunEvidence } from "../src/diagnostics/test-run-evidence";

const noTest = process.argv.includes("--no-test");
function sh(label: string, cmd: string, args: string[]): string {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  const verdict = judgeProcess(label, result);
  if (!verdict.ok) throw new Error(verdict.reason);
  return (result.stdout ?? "").trim();
}

const branch = sh("git branch", "git", ["rev-parse", "--abbrev-ref", "HEAD"]);
const head = sh("git head", "git", ["log", "--oneline", "-1"]);
const dirty = sh("git status", "git", ["status", "--short"]).split("\n").filter(Boolean);
const untrackedTestStatus = dirty.filter((entry) =>
  entry.startsWith("?? ") && /(?:^|[\\/])[^\\/]+\.test\.[^\\/]+$/.test(entry.trim()),
);
const visibleDirty = dirty.filter((entry) => !untrackedTestStatus.includes(entry));
const recent = sh("git history", "git", ["log", "--oneline", "-8"]).split("\n").filter(Boolean);

let testLine = "（本次未跑）";
let testFailureDiagnostics: string[] = [];
if (!noTest) {
  const baseline = existsSync("docs/test-baseline.json")
    ? (JSON.parse(readFileSync("docs/test-baseline.json", "utf8")) as TestBaseline)
    : null;
  // Drain both streams until Bun emits its terminal summary; spawnSync's
  // fixed capture buffer can otherwise truncate a healthy full suite.
  const evidence = await collectTestRunEvidence(
    "bun",
    ["test", "--parallel=1", "--timeout", "30000"],
    baseline ?? { tests: 0, files: 0 },
  );
  if (!evidence.ok) testFailureDiagnostics = boundedBunFailureDiagnostics(evidence.output);
  testLine = !evidence.ok
    ? `（测试未通过：${evidence.reason}）`
    : !baseline
      ? "（测试未通过：缺少测试基线 docs/test-baseline.json —— 不能当成通过）"
      : `${evidence.count.tests} 条 / ${evidence.count.files} 文件  全绿`;
}

// 待办：从 todo.json 取 warn 级
type CurrentWorkItem = {
  id?: unknown;
  severity?: unknown;
  latestText?: unknown;
  text?: unknown;
  latestPlayerIntentProgress?: unknown;
  npcRuntimeTransitionAtomicityClosure?: unknown;
  npcRuntimeTransitionAtomicityVerification?: unknown;
  npcRuntimeTransitionAtomicityOpenScope?: unknown;
  npcCliFanoutAtomicityClosure?: unknown;
  npcCliFanoutAtomicityVerification?: unknown;
  npcCliFanoutAtomicityOpenScope?: unknown;
  npcMemoryAppendAtomicityClosure?: unknown;
  npcMemoryAppendAtomicityVerification?: unknown;
  npcMemoryAppendAtomicityOpenScope?: unknown;
  npcAgentPrivateMemoryStateDispatchClosure?: unknown;
  npcAgentPrivateMemoryStateDispatchVerification?: unknown;
  npcAgentPrivateMemoryStateDispatchOpenScope?: unknown;
  careerLeafLockDeadOwnerRecoveryClosure?: unknown;
  careerLeafLockDeadOwnerRecoveryVerification?: unknown;
  careerLeafLockDeadOwnerRecoveryOpenScope?: unknown;
  gameSessionSetSceneWriterRetirementClosure?: unknown;
  gameSessionSetSceneWriterRetirementVerification?: unknown;
  gameSessionSetSceneWriterRetirementOpenScope?: unknown;
  gameSessionWorldFacadeLifecycleClosure?: unknown;
  gameSessionWorldFacadeLifecycleVerification?: unknown;
  gameSessionWorldFacadeLifecycleOpenScope?: unknown;
  gameSessionClosedLifecycleMutatorGuardClosure?: unknown;
  gameSessionClosedLifecycleMutatorGuardVerification?: unknown;
  gameSessionClosedLifecycleMutatorGuardOpenScope?: unknown;
  playerSessionVisibleToWriterRetirementClosure?: unknown;
  playerSessionVisibleToWriterRetirementVerification?: unknown;
  playerSessionVisibleToWriterRetirementOpenScope?: unknown;
  legacyWorldStateReadOwnershipClosure?: unknown;
  legacyWorldStateReadOwnershipVerification?: unknown;
  legacyWorldStateReadOwnershipFinalVerification?: unknown;
  legacyWorldStateReadOwnershipOpenScope?: unknown;
  worldDurableCurrentRoundSnapshotAtomicityClosure?: unknown;
  worldDurableCurrentRoundSnapshotAtomicityVerification?: unknown;
  worldDurableCurrentRoundSnapshotAtomicityFinalVerification?: unknown;
  worldDurableCurrentRoundSnapshotAtomicityOpenScope?: unknown;
  openingLifecycleDockerAndBindingCurrentScope?: unknown;
  compilerAutoAdmissionStartupClosure?: unknown;
  compilerAutoAdmissionStartupVerification?: unknown;
  compilerAutoAdmissionStartupOpenScope?: unknown;
  pdfPrepareIngressAdmissionClosure?: unknown;
  pdfPrepareIngressAdmissionVerification?: unknown;
  pdfPrepareIngressAdmissionOpenScope?: unknown;
  compiledSessionCreationIngressClosure?: unknown;
  compiledSessionCreationIngressVerification?: unknown;
  compiledSessionCreationIngressOpenScope?: unknown;
  nowAsyncDrainClosure?: unknown;
  nowAsyncDrainVerification?: unknown;
  nowAsyncDrainFinalVerification?: unknown;
  nowAsyncDrainOpenScope?: unknown;
  worldSingleActiveSceneInvariantClosure?: unknown;
  worldSingleActiveSceneInvariantVerification?: unknown;
  worldSingleActiveSceneInvariantFinalVerification?: unknown;
  worldSingleActiveSceneInvariantOpenScope?: unknown;
  worldRelationshipReverseFirstCreateClosure?: unknown;
  worldRelationshipReverseFirstCreateVerification?: unknown;
  worldRelationshipReverseFirstCreateFinalVerification?: unknown;
  worldRelationshipReverseFirstCreateOpenScope?: unknown;
  compilerJsonIngressAdmissionClosure?: unknown;
  compilerJsonIngressAdmissionVerification?: unknown;
  compilerJsonIngressAdmissionOpenScope?: unknown;
  compiledWorldBindingProductionRegistryClosure?: unknown;
  compiledWorldBindingProductionRegistryVerification?: unknown;
  compiledWorldBindingProductionRegistryOpenScope?: unknown;
  dockerExternalWorldModelMountClosure?: unknown;
  dockerExternalWorldModelMountVerification?: unknown;
  dockerExternalWorldModelMountOpenScope?: unknown;
  openingAdmissionLifecycleOpenScope?: unknown;
  gameSessionCreatePartyMemberPrivateAuthorityClosure?: unknown;
  gameSessionCreatePartyMemberPrivateAuthorityVerification?: unknown;
  gameSessionCreatePartyMemberPrivateAuthorityOpenScope?: unknown;
  careerHelperRuntimePrivateAuthorityClosure?: unknown;
  careerHelperRuntimePrivateAuthorityVerification?: unknown;
  careerHelperRuntimePrivateAuthorityOpenScope?: unknown;
  preflightAsyncDrainClosure?: unknown;
  preflightAsyncDrainVerification?: unknown;
  preflightAsyncDrainOpenScope?: unknown;
  gameSessionConstructorInstallerPrivateAuthorityProgress?: unknown;
  gameSessionConstructorInstallerPrivateAuthorityVerification?: unknown;
  gameSessionConstructorInstallerPrivateAuthorityOpenScope?: unknown;
  ordinaryOperatorRecoveryClosure?: unknown;
  ordinaryOperatorRecoveryVerification?: unknown;
  ordinaryOperatorRecoveryOpenScope?: unknown;
  compiledActionRuntimePrivateCanonicalCohortClosure?: unknown;
  compiledActionRuntimePrivateCanonicalCohortVerification?: unknown;
  compiledActionRuntimePrivateCanonicalCohortOpenScope?: unknown;
  ordinarySnapshotReplayDirectoryNodeOccupancyClosure?: unknown;
  ordinarySnapshotReplayDirectoryNodeOccupancyVerification?: unknown;
  ordinarySnapshotReplayDirectoryNodeOccupancyOpenScope?: unknown;
  compiledActionRuntimePrivateLoadInstallAuthorityClosure?: unknown;
  compiledActionRuntimePrivateLoadInstallAuthorityVerification?: unknown;
  compiledActionRuntimePrivateLoadInstallAuthorityOpenScope?: unknown;
  compilerAutoHintProposalSingleAttemptClosure?: unknown;
  compilerAutoHintProposalSingleAttemptVerification?: unknown;
  compilerAutoHintProposalSingleAttemptOpenScope?: unknown;
  ordinaryDurableProviderSingleAttemptClosure?: unknown;
  ordinaryDurableProviderSingleAttemptVerification?: unknown;
  ordinaryDurableProviderSingleAttemptOpenScope?: unknown;
  legacyOrdinaryRuntimeInstallPrivateAuthorityClosure?: unknown;
  legacyOrdinaryRuntimeInstallPrivateAuthorityVerification?: unknown;
  legacyOrdinaryRuntimeInstallPrivateAuthorityOpenScope?: unknown;
  [field: string]: unknown;
};

let warns: string[] = [];
let currentProductionQuality = "";
if (existsSync("docs/todo.json")) {
  const todo = JSON.parse(readFileSync("docs/todo.json", "utf8"));
  const items = todo.items as CurrentWorkItem[];
  const current = items.find((i) => i.id === "todo-64");
  const admission = items.find((i) => i.id === "todo-65");
  const newestClosures = [
    admission?.npcRuntimeTransitionAtomicityClosure,
    admission?.npcCliFanoutAtomicityClosure,
    admission?.npcMemoryAppendAtomicityClosure,
    admission?.npcAgentPrivateMemoryStateDispatchClosure,
    admission?.careerLeafLockDeadOwnerRecoveryClosure,
    admission?.gameSessionSetSceneWriterRetirementClosure,
    admission?.gameSessionWorldFacadeLifecycleClosure,
    admission?.gameSessionClosedLifecycleMutatorGuardClosure,
    admission?.playerSessionVisibleToWriterRetirementClosure,
    admission?.legacyWorldStateReadOwnershipClosure,
    admission?.worldDurableCurrentRoundSnapshotAtomicityClosure,
    admission?.nowAsyncDrainClosure,
    admission?.worldSingleActiveSceneInvariantClosure,
    admission?.worldRelationshipReverseFirstCreateClosure,
    current?.compiledSessionCreationIngressClosure,
    current?.compilerJsonIngressAdmissionClosure,
    current?.pdfPrepareIngressAdmissionClosure,
    current?.compilerAutoAdmissionStartupClosure,
    current?.dockerExternalWorldModelMountClosure,
    current?.compiledWorldBindingProductionRegistryClosure,
    admission?.legacyOrdinaryRuntimeInstallPrivateAuthorityClosure,
    admission?.ordinaryDurableProviderSingleAttemptClosure,
    admission?.compiledActionRuntimePrivateLoadInstallAuthorityClosure,
    admission?.compilerAutoHintProposalSingleAttemptClosure,
    admission?.compiledActionRuntimePrivateCanonicalCohortClosure,
    admission?.ordinarySnapshotReplayDirectoryNodeOccupancyClosure,
    admission?.gameSessionConstructorInstallerPrivateAuthorityProgress,
    admission?.preflightAsyncDrainClosure,
    admission?.careerHelperRuntimePrivateAuthorityClosure,
    admission?.gameSessionCreatePartyMemberPrivateAuthorityClosure,
    admission?.gameSessionCreatePartyMemberPrivateAuthorityOpenScope,
    admission?.ordinaryOperatorRecoveryClosure,
    current?.openingLifecycleDockerAndBindingCurrentScope,
    current?.sceneEnvironmentAtomicityClosure,
    current?.entityUpsertAtomicityClosure,
    current?.incrementClueFailAtomicityClosure,
    current?.tickEffectsAtomicityClosure,
    current?.applyDamageAtomicityClosure,
    current?.preflightReliabilityClosure,
    current?.activeSceneAtomicityClosure,
    current?.ordinaryFirstAcquireRaceClosure,
    current?.gameSessionPublicViewIsolationClosure,
    current?.worldModelPromptStructuredValueClosure,
    current?.sharedWorldModelIsolationClosure,
    current?.barnCrossPageAtomClosure,
    current?.ordinarySnapshotBuildDomainClosure,
    current?.compiledIntentAdmissionContentionClosure,
    current?.ordinaryHpTruthAndBoundaryAuditClosure,
    current?.twoRealModuleAndScopedWorldModelProgress,
    current?.freshRuntimeAndWorldAvailabilityClosure,
    current?.fuzuCurrentSchemaAcceptanceClosure,
    current?.diagnosticIntentApiProgress,
    current?.controlStatePruningClosure,
    current?.ordinaryProseFactFindingClosure,
    current?.compiledSessionSnapshotQuotaGcClosure,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  currentProductionQuality = newestClosures.length
    ? newestClosures.map((value) => value.trim()).join("\n\n")
    : typeof current?.compiledSessionSnapshotCasClosure === "string"
    ? current.compiledSessionSnapshotCasClosure.trim()
    : typeof current?.catalogCrossProcessQuotaClosure === "string"
    ? current.catalogCrossProcessQuotaClosure.trim()
    : typeof current?.catalogDurablePublicationClosure === "string"
    ? current.catalogDurablePublicationClosure.trim()
    : typeof current?.automaticSourceExactNpcEncounterClosure === "string"
    ? current.automaticSourceExactNpcEncounterClosure.trim()
    : typeof current?.fuzuTrackedReviewFixtureClosure === "string"
    ? current.fuzuTrackedReviewFixtureClosure.trim()
    : typeof current?.actorEffectEventSlotClosure === "string"
    ? current.actorEffectEventSlotClosure.trim()
    : typeof current?.filmSanityOpeningClosure === "string"
    ? current.filmSanityOpeningClosure.trim()
    : typeof current?.latestSourceRuntimeQualityProgress === "string"
      ? current.latestSourceRuntimeQualityProgress.trim()
      : "";
  warns = items
    .filter((i) => i.severity === "warn")
    .flatMap((i) => {
      if (i.id === "todo-65") {
        // Keep the explicit priority list itemized: the rendered warn bullets
        // are individually bounded, so one newer scope cannot truncate an
        // older allowlisted scope out of the snapshot.
        return [
          i.npcRuntimeTransitionAtomicityOpenScope,
          i.npcCliFanoutAtomicityOpenScope,
          i.npcMemoryAppendAtomicityOpenScope,
          i.npcAgentPrivateMemoryStateDispatchOpenScope,
          i.careerLeafLockDeadOwnerRecoveryOpenScope,
          i.gameSessionSetSceneWriterRetirementOpenScope,
          i.gameSessionWorldFacadeLifecycleOpenScope,
          i.gameSessionClosedLifecycleMutatorGuardOpenScope,
          i.playerSessionVisibleToWriterRetirementOpenScope,
          i.legacyWorldStateReadOwnershipOpenScope,
          i.worldDurableCurrentRoundSnapshotAtomicityOpenScope,
          i.nowAsyncDrainOpenScope,
          i.worldSingleActiveSceneInvariantOpenScope,
          i.worldRelationshipReverseFirstCreateOpenScope,
          i.legacyOrdinaryRuntimeInstallPrivateAuthorityOpenScope,
          i.ordinaryDurableProviderSingleAttemptOpenScope,
          i.compiledActionRuntimePrivateLoadInstallAuthorityOpenScope,
          i.compilerAutoHintProposalSingleAttemptOpenScope,
          i.compiledActionRuntimePrivateCanonicalCohortOpenScope,
          i.ordinarySnapshotReplayDirectoryNodeOccupancyOpenScope,
          i.gameSessionConstructorInstallerPrivateAuthorityOpenScope,
          i.preflightAsyncDrainOpenScope,
          i.careerHelperRuntimePrivateAuthorityOpenScope,
          i.gameSessionCreatePartyMemberPrivateAuthorityOpenScope,
          i.ordinaryOperatorRecoveryOpenScope,
          i.openingAdmissionLifecycleOpenScope,
          i.latestText,
          i.text,
        ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      }
      const value = i.id === "todo-64"
        ? currentProductionQuality || i.latestPlayerIntentProgress
        : i.latestText ?? i.text;
      return typeof value === "string" ? [value] : [];
    });
}

// log 里状态为 open 的记录 = 已定位未修
let open: Array<{ title: string; file: string; line: number }> = [];
if (existsSync("docs/notes/index.json")) {
  const idx = JSON.parse(readFileSync("docs/notes/index.json", "utf8"));
  open = idx.records
    .filter((r: any) => r.status === "open" || r.status === "warn")
    .map((r: any) => ({ title: r.title, file: r.file, line: r.line }));
}

const md = `# 现在在哪

> 每个会话开头读这一份就够。刷新：\`bun scripts/now.ts\`
> 生成于 ${new Date().toISOString().slice(0, 16).replace("T", " ")}
>
> ⚠ 这份文件永远落后自己所在的那个提交一步：流程是先跑这个脚本生成
> 快照、再把快照本身提交，所以刷新时看到的 HEAD 就是"这次要提交的
> 上一个"，工作树里也总会看到 \`docs/now.md\`（有时还有 \`docs/handoff.md\`）
> 自己待提交。这是工具固有的生成顺序，不是 bug，也不代表遗漏了什么。

## 状态

| | |
|---|---|
| 分支 | \`${branch}\` |
| HEAD | ${head} |
| 测试 | ${testLine} |
| 工作树 | ${dirty.length === 0 ? "干净" : `**${dirty.length} 个文件未提交**`} |
${visibleDirty.length ? "\n未提交：\n" + visibleDirty.map((d) => "- `" + d.trim() + "`").join("\n") + "\n" : ""}${untrackedTestStatus.length ? `\n未跟踪测试：${untrackedTestStatus.length} 个（路径不在状态页枚举；用 \`git status --short\` 查看）\n` : ""}
## 开工前

\`\`\`
bun scripts/preflight.ts     # 改动前后各跑一次，机器判据挡住反复犯的错
bun scripts/now.ts           # 收工前刷新这份文件
\`\`\`

${currentProductionQuality ? `## 当前来源→运行质量收口

${currentProductionQuality}

` : ""}## 已定位未修（${open.length}）

${open.length ? open.map((o) => `- ${o.title}\n  \`${o.file}:${o.line}\``).join("\n") : "（无）"}

## 动手前先扫一眼的坑（${warns.length}）

${warns.map((w) => "- " + w.replace(/\n/g, " ").slice(0, 150).trimEnd()).join("\n")}

## 最近提交

${recent.map((r) => "- " + r).join("\n")}

## 找东西

| 我想…… | 怎么做 |
|---|---|
| 看架构 | \`bun scripts/docs-index.ts arch <关键词>\` |
| 查某问题记录过没 | \`bun scripts/docs-index.ts log <关键词>\` |
| 看全部待办 | \`bun scripts/docs-index.ts todo\` |
| 读记录正文 | 按 \`log\` 给出的 \`file:line\` 用 Read 取 |

⚠ **不要用 \`Select-String\` / \`Get-Content\` 读仓库源码** —— UTF-8 无 BOM，
PowerShell 会退回 ANSI 码页，中文全成乱码。用 Read/Grep 工具或 \`fs.readFileSync\`。
`;

// Exit success means the snapshot was written, not that its test child passed.
writeFileSync("docs/now.md", md, "utf8");
console.log(`docs/now.md 已刷新 —— ${branch} / ${testLine} / 未修 ${open.length} 项`);
if (testFailureDiagnostics.length) {
  console.log("\n  bun test bounded failure context:");
  for (const line of testFailureDiagnostics) console.log("    " + line);
}
