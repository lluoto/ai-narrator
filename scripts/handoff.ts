// 生成 docs/handoff.md —— 交给下一个会话／另一个模型的接手说明。
//
// 与 now.md 的分工：
//   now.md   「现在在哪」—— 状态快照，每次收工刷新
//   handoff  「怎么接手」—— 项目是什么、纪律是什么、坑在哪、怎么验
//
// 做成脚本生成是为了让状态部分不会过期；叙述部分写死在模板里。

import { readFileSync, writeFileSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import { boundedBunFailureDiagnostics, judgeProcess, type TestBaseline } from "../src/diagnostics/source-scan";
import { collectTestRunEvidence } from "../src/diagnostics/test-run-evidence";

function sh(label: string, command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const verdict = judgeProcess(label, result);
  if (!verdict.ok) throw new Error(verdict.reason);
  return (result.stdout ?? "").trim();
}

const head = sh("git head", "git", ["log", "--oneline", "-1"]);
const recent = sh("git history", "git", ["log", "--oneline", "-12"]).split("\n").filter(Boolean);

// 基线在 docs/test-baseline.json，preflight 拿它做回归判据。
// 这里一并打出来 —— 「当前条数」单看没有意义，得有个比较对象。
const baseline = existsSync("docs/test-baseline.json")
  ? (JSON.parse(readFileSync("docs/test-baseline.json", "utf8")) as TestBaseline)
  : null;

let tests = "（未跑）";
let testFailureDiagnostics: string[] = [];
if (!process.argv.includes("--no-test")) {
  // Full Bun output can exceed spawnSync's fixed maxBuffer before its terminal
  // summary. The shared capture drains stdout/stderr concurrently and refuses
  // startup, stream, limit, exit, or summary failures as test evidence.
  const evidence = await collectTestRunEvidence("bun", ["test", "--parallel=1", "--timeout", "30000"], baseline ?? { tests: 0, files: 0 });
  const count = evidence.count;
  const vs = baseline && count.tests !== null ? `（基线 ${baseline.tests}${count.tests < baseline.tests ? " —— **回退了**" : count.tests > baseline.tests ? " —— 记得上调" : "，一致"}）` : "";
  tests = !evidence.ok
    ? `（测试未通过：${evidence.reason}）`
      : `${count.tests} 条 / ${count.files} 文件，全绿${vs}`;
  if (!evidence.ok) testFailureDiagnostics = boundedBunFailureDiagnostics(evidence.output);
}

type CurrentWorkItem = {
  id?: unknown;
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
  nowAsyncDrainClosure?: unknown;
  nowAsyncDrainVerification?: unknown;
  nowAsyncDrainFinalVerification?: unknown;
  nowAsyncDrainOpenScope?: unknown;
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
  handoffProcessCaptureClosure?: unknown;
  handoffProcessCaptureVerification?: unknown;
  handoffProcessCaptureOpenScope?: unknown;
  compiledIntentDurableReplayClosure?: unknown;
  compiledIntentDurableReplayVerification?: unknown;
  compiledIntentDurableReplayOpenScope?: unknown;
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
  sceneEnvironmentAtomicityClosure?: unknown;
  sceneEnvironmentAtomicityVerification?: unknown;
  entityUpsertAtomicityClosure?: unknown;
  entityUpsertAtomicityVerification?: unknown;
  incrementClueFailAtomicityClosure?: unknown;
  incrementClueFailAtomicityVerification?: unknown;
  tickEffectsAtomicityClosure?: unknown;
  tickEffectsAtomicityVerification?: unknown;
  applyDamageAtomicityClosure?: unknown;
  applyDamageAtomicityVerification?: unknown;
  preflightReliabilityClosure?: unknown;
  preflightReliabilityVerification?: unknown;
  activeSceneAtomicityClosure?: unknown;
  activeSceneAtomicityVerification?: unknown;
  ordinaryFirstAcquireRaceClosure?: unknown;
  ordinaryFirstAcquireRaceVerification?: unknown;
  gameSessionPublicViewIsolationClosure?: unknown;
  gameSessionPublicViewIsolationVerification?: unknown;
  worldModelPromptStructuredValueClosure?: unknown;
  worldModelPromptStructuredValueVerification?: unknown;
  sharedWorldModelIsolationClosure?: unknown;
  sharedWorldModelIsolationVerification?: unknown;
  barnCrossPageAtomClosure?: unknown;
  barnCrossPageAtomVerification?: unknown;
  ordinarySnapshotBuildDomainClosure?: unknown;
  ordinarySnapshotBuildDomainVerification?: unknown;
  compiledIntentAdmissionContentionClosure?: unknown;
  compiledIntentAdmissionContentionVerification?: unknown;
  ordinaryHpTruthAndBoundaryAuditClosure?: unknown;
  ordinaryHpTruthAndBoundaryAuditVerification?: unknown;
  twoRealModuleAndScopedWorldModelProgress?: unknown;
  twoRealModuleAndScopedWorldModelVerification?: unknown;
  freshRuntimeAndWorldAvailabilityClosure?: unknown;
  freshRuntimeAndWorldAvailabilityVerification?: unknown;
  diagnosticIntentApiProgress?: unknown;
  diagnosticIntentApiVerification?: unknown;
  fuzuCurrentSchemaAcceptanceClosure?: unknown;
  fuzuCurrentSchemaAcceptanceVerification?: unknown;
  controlStatePruningClosure?: unknown;
  controlStatePruningVerification?: unknown;
  ordinaryProseFactFindingClosure?: unknown;
  ordinaryProseFactFindingVerification?: unknown;
  compiledSessionSnapshotQuotaGcClosure?: unknown;
  compiledSessionSnapshotQuotaGcVerification?: unknown;
  compiledSessionSnapshotCasClosure?: unknown;
  compiledSessionSnapshotCasVerification?: unknown;
  catalogCrossProcessQuotaClosure?: unknown;
  catalogCrossProcessQuotaVerification?: unknown;
  catalogDurablePublicationClosure?: unknown;
  catalogDurablePublicationVerification?: unknown;
  automaticSourceExactNpcEncounterClosure?: unknown;
  automaticSourceExactNpcEncounterVerification?: unknown;
  fuzuTrackedReviewFixtureClosure?: unknown;
  fuzuTrackedReviewFixtureVerification?: unknown;
  actorEffectEventSlotClosure?: unknown;
  actorEffectEventSlotVerification?: unknown;
  filmSanityOpeningClosure?: unknown;
  filmSanityOpeningVerification?: unknown;
  clueFactFacetClosure?: unknown;
  clueFactFacetVerification?: unknown;
  latestSourceRuntimeQualityProgress?: unknown;
  latestSourceRuntimeQualityVerification?: unknown;
  latestPlayerIntentProgress?: unknown;
  latestPlayerIntentVerification?: unknown;
  latestSourceRuntimeProgress?: unknown;
  latestSourceRuntimeVerification?: unknown;
  latestPlayerDeliveryProgress?: unknown;
  latestPlayerDeliveryVerification?: unknown;
};

function renderCurrentProductionIncrement(items: CurrentWorkItem[]): string {
  const item = items.find((candidate) => candidate.id === "todo-64");
  const admission = items.find((candidate) => candidate.id === "todo-65");
  const currentScopes = [
    admission?.npcRuntimeTransitionAtomicityOpenScope,
    admission?.npcCliFanoutAtomicityOpenScope,
    admission?.npcMemoryAppendAtomicityOpenScope,
    admission?.npcAgentPrivateMemoryStateDispatchOpenScope,
    admission?.careerLeafLockDeadOwnerRecoveryOpenScope,
    admission?.gameSessionSetSceneWriterRetirementOpenScope,
    admission?.gameSessionWorldFacadeLifecycleOpenScope,
    admission?.gameSessionClosedLifecycleMutatorGuardOpenScope,
    admission?.playerSessionVisibleToWriterRetirementOpenScope,
    admission?.legacyWorldStateReadOwnershipOpenScope,
    admission?.worldDurableCurrentRoundSnapshotAtomicityOpenScope,
    admission?.nowAsyncDrainOpenScope,
    admission?.worldSingleActiveSceneInvariantOpenScope,
    admission?.worldRelationshipReverseFirstCreateOpenScope,
    admission?.compiledIntentDurableReplayOpenScope,
    admission?.handoffProcessCaptureOpenScope,
    item?.compiledSessionCreationIngressOpenScope,
    item?.compilerJsonIngressAdmissionOpenScope,
    item?.pdfPrepareIngressAdmissionOpenScope,
    item?.compilerAutoAdmissionStartupOpenScope,
    item?.dockerExternalWorldModelMountOpenScope,
    item?.compiledWorldBindingProductionRegistryOpenScope,
    item?.openingLifecycleDockerAndBindingCurrentScope,
    admission?.legacyOrdinaryRuntimeInstallPrivateAuthorityOpenScope,
    admission?.ordinaryDurableProviderSingleAttemptOpenScope,
    admission?.compiledActionRuntimePrivateLoadInstallAuthorityOpenScope,
    admission?.compilerAutoHintProposalSingleAttemptOpenScope,
    admission?.compiledActionRuntimePrivateCanonicalCohortOpenScope,
    admission?.ordinarySnapshotReplayDirectoryNodeOccupancyOpenScope,
    admission?.gameSessionConstructorInstallerPrivateAuthorityOpenScope,
    admission?.preflightAsyncDrainOpenScope,
    admission?.careerHelperRuntimePrivateAuthorityOpenScope,
    admission?.gameSessionCreatePartyMemberPrivateAuthorityOpenScope,
    admission?.ordinaryOperatorRecoveryOpenScope,
    admission?.openingAdmissionLifecycleOpenScope,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  const candidates: Array<readonly [unknown, unknown]> = [
    [
      admission?.npcRuntimeTransitionAtomicityClosure,
      admission?.npcRuntimeTransitionAtomicityVerification,
    ],
    [
      admission?.npcCliFanoutAtomicityClosure,
      admission?.npcCliFanoutAtomicityVerification,
    ],
    [
      admission?.npcMemoryAppendAtomicityClosure,
      admission?.npcMemoryAppendAtomicityVerification,
    ],
    [
      admission?.npcAgentPrivateMemoryStateDispatchClosure,
      admission?.npcAgentPrivateMemoryStateDispatchVerification,
    ],
    [
      admission?.careerLeafLockDeadOwnerRecoveryClosure,
      admission?.careerLeafLockDeadOwnerRecoveryVerification,
    ],
    [
      admission?.gameSessionSetSceneWriterRetirementClosure,
      admission?.gameSessionSetSceneWriterRetirementVerification,
    ],
    [
      admission?.gameSessionWorldFacadeLifecycleClosure,
      admission?.gameSessionWorldFacadeLifecycleVerification,
    ],
    [
      admission?.gameSessionClosedLifecycleMutatorGuardClosure,
      admission?.gameSessionClosedLifecycleMutatorGuardVerification,
    ],
    [
      admission?.playerSessionVisibleToWriterRetirementClosure,
      admission?.playerSessionVisibleToWriterRetirementVerification,
    ],
    [
      admission?.legacyWorldStateReadOwnershipClosure,
      admission?.legacyWorldStateReadOwnershipFinalVerification
        ?? admission?.legacyWorldStateReadOwnershipVerification,
    ],
    [
      admission?.worldDurableCurrentRoundSnapshotAtomicityClosure,
      admission?.worldDurableCurrentRoundSnapshotAtomicityFinalVerification
        ?? admission?.worldDurableCurrentRoundSnapshotAtomicityVerification,
    ],
    [
      admission?.nowAsyncDrainClosure,
      admission?.nowAsyncDrainFinalVerification ?? admission?.nowAsyncDrainVerification,
    ],
    [
      admission?.worldSingleActiveSceneInvariantClosure,
      admission?.worldSingleActiveSceneInvariantFinalVerification
        ?? admission?.worldSingleActiveSceneInvariantVerification,
    ],
    [
      admission?.worldRelationshipReverseFirstCreateClosure,
      admission?.worldRelationshipReverseFirstCreateFinalVerification
        ?? admission?.worldRelationshipReverseFirstCreateVerification,
    ],
    [admission?.compiledIntentDurableReplayClosure, admission?.compiledIntentDurableReplayVerification],
    [admission?.handoffProcessCaptureClosure, admission?.handoffProcessCaptureVerification],
    [item?.compiledSessionCreationIngressClosure, item?.compiledSessionCreationIngressVerification],
    [item?.compilerJsonIngressAdmissionClosure, item?.compilerJsonIngressAdmissionVerification],
    [item?.pdfPrepareIngressAdmissionClosure, item?.pdfPrepareIngressAdmissionVerification],
    [item?.compilerAutoAdmissionStartupClosure, item?.compilerAutoAdmissionStartupVerification],
    [item?.dockerExternalWorldModelMountClosure, item?.dockerExternalWorldModelMountVerification],
    [item?.compiledWorldBindingProductionRegistryClosure, item?.compiledWorldBindingProductionRegistryVerification],
    [admission?.legacyOrdinaryRuntimeInstallPrivateAuthorityClosure, admission?.legacyOrdinaryRuntimeInstallPrivateAuthorityVerification],
    [admission?.ordinaryDurableProviderSingleAttemptClosure, admission?.ordinaryDurableProviderSingleAttemptVerification],
    [admission?.compiledActionRuntimePrivateLoadInstallAuthorityClosure, admission?.compiledActionRuntimePrivateLoadInstallAuthorityVerification],
    [admission?.compilerAutoHintProposalSingleAttemptClosure, admission?.compilerAutoHintProposalSingleAttemptVerification],
    [admission?.compiledActionRuntimePrivateCanonicalCohortClosure, admission?.compiledActionRuntimePrivateCanonicalCohortVerification],
    [admission?.ordinarySnapshotReplayDirectoryNodeOccupancyClosure, admission?.ordinarySnapshotReplayDirectoryNodeOccupancyVerification],
    [admission?.gameSessionConstructorInstallerPrivateAuthorityProgress, admission?.gameSessionConstructorInstallerPrivateAuthorityVerification],
    [admission?.preflightAsyncDrainClosure, admission?.preflightAsyncDrainVerification],
    [admission?.careerHelperRuntimePrivateAuthorityClosure, admission?.careerHelperRuntimePrivateAuthorityVerification],
    [admission?.gameSessionCreatePartyMemberPrivateAuthorityClosure, admission?.gameSessionCreatePartyMemberPrivateAuthorityVerification],
    [admission?.ordinaryOperatorRecoveryClosure, admission?.ordinaryOperatorRecoveryVerification],
    [item?.sceneEnvironmentAtomicityClosure, item?.sceneEnvironmentAtomicityVerification],
    [item?.entityUpsertAtomicityClosure, item?.entityUpsertAtomicityVerification],
    [item?.incrementClueFailAtomicityClosure, item?.incrementClueFailAtomicityVerification],
    [item?.tickEffectsAtomicityClosure, item?.tickEffectsAtomicityVerification],
    [item?.applyDamageAtomicityClosure, item?.applyDamageAtomicityVerification],
    [item?.preflightReliabilityClosure, item?.preflightReliabilityVerification],
    [item?.activeSceneAtomicityClosure, item?.activeSceneAtomicityVerification],
    [item?.ordinaryFirstAcquireRaceClosure, item?.ordinaryFirstAcquireRaceVerification],
    [item?.gameSessionPublicViewIsolationClosure, item?.gameSessionPublicViewIsolationVerification],
    [item?.worldModelPromptStructuredValueClosure, item?.worldModelPromptStructuredValueVerification],
    [item?.sharedWorldModelIsolationClosure, item?.sharedWorldModelIsolationVerification],
    [item?.barnCrossPageAtomClosure, item?.barnCrossPageAtomVerification],
    [item?.ordinarySnapshotBuildDomainClosure, item?.ordinarySnapshotBuildDomainVerification],
    [item?.compiledIntentAdmissionContentionClosure, item?.compiledIntentAdmissionContentionVerification],
    [item?.ordinaryHpTruthAndBoundaryAuditClosure, item?.ordinaryHpTruthAndBoundaryAuditVerification],
    [item?.twoRealModuleAndScopedWorldModelProgress, item?.twoRealModuleAndScopedWorldModelVerification],
    [item?.freshRuntimeAndWorldAvailabilityClosure, item?.freshRuntimeAndWorldAvailabilityVerification],
    [item?.fuzuCurrentSchemaAcceptanceClosure, item?.fuzuCurrentSchemaAcceptanceVerification],
    [item?.diagnosticIntentApiProgress, item?.diagnosticIntentApiVerification],
    [item?.controlStatePruningClosure, item?.controlStatePruningVerification],
    [item?.ordinaryProseFactFindingClosure, item?.ordinaryProseFactFindingVerification],
    [item?.compiledSessionSnapshotQuotaGcClosure, item?.compiledSessionSnapshotQuotaGcVerification],
    [item?.compiledSessionSnapshotCasClosure, item?.compiledSessionSnapshotCasVerification],
    [item?.catalogCrossProcessQuotaClosure, item?.catalogCrossProcessQuotaVerification],
    [item?.catalogDurablePublicationClosure, item?.catalogDurablePublicationVerification],
    [item?.automaticSourceExactNpcEncounterClosure, item?.automaticSourceExactNpcEncounterVerification],
    [item?.fuzuTrackedReviewFixtureClosure, item?.fuzuTrackedReviewFixtureVerification],
    [item?.actorEffectEventSlotClosure, item?.actorEffectEventSlotVerification],
    [item?.filmSanityOpeningClosure, item?.filmSanityOpeningVerification],
    [item?.clueFactFacetClosure, item?.clueFactFacetVerification],
    [item?.latestSourceRuntimeQualityProgress, item?.latestSourceRuntimeQualityVerification],
    [item?.latestPlayerIntentProgress, item?.latestPlayerIntentVerification],
    [item?.latestSourceRuntimeProgress, item?.latestSourceRuntimeVerification],
    [item?.latestPlayerDeliveryProgress, item?.latestPlayerDeliveryVerification],
  ];
  // Keep a bounded, explicit ten-record priority cohort. New NPC runtime
  // and CLI-fanout records lead it while retaining the eight older allowlisted
  // mappings, instead of being replaced by a broad historic scan.
  const currentLimit = Math.max(5, candidates.slice(0, 10).filter(([scopeCandidate, verificationCandidate]) => (
    typeof scopeCandidate === "string" && scopeCandidate.trim().length > 0
      && typeof verificationCandidate === "string" && verificationCandidate.trim().length > 0
  )).length);
  const current = candidates
    .map(([scopeCandidate, verificationCandidate]): [string, string] => [
      typeof scopeCandidate === "string" ? scopeCandidate.trim() : "",
      typeof verificationCandidate === "string" ? verificationCandidate.trim() : "",
    ])
    .filter(([scope, verification]) => Boolean(scope && verification))
    .slice(0, currentLimit);
  if (currentScopes.length === 0 && current.length === 0) return "";
  const scope = [...currentScopes, ...current.map(([value]) => value)].join("\n\n");
  const verification = current.map(([, value]) => value).join("\n\n");
  return `## 当前生产化增量

${scope}
${verification ? `

### 验收记录

${verification}` : ""}`;
}

const todo = existsSync("docs/todo.json")
  ? JSON.parse(readFileSync("docs/todo.json", "utf8"))
  : null;
const rules = todo?.items.filter((i: any) => i.category === "工作约定") ?? [];
const currentProductionIncrement = renderCurrentProductionIncrement(todo?.items ?? []);

const openItems = existsSync("docs/notes/index.json")
  ? JSON.parse(readFileSync("docs/notes/index.json", "utf8")).records
      .filter((r: any) => r.status === "open" || r.status === "warn")
  : [];

// Keep the active, handwritten acceptance record verbatim, including subheadings.
const checkpoint = existsSync("docs/handoff.md")
  ? readFileSync("docs/handoff.md", "utf8").match(/^## 编译闭环检查点 I 交接\r?\n[\s\S]*?(?=^## |$(?![\s\S]))/m)?.[0] ?? ""
  : "";

const md = `# 接手说明

> 生成于 ${new Date().toISOString().slice(0, 16).replace("T", " ")}  ·  刷新：\`bun scripts/handoff.ts\`
> 状态快照看 \`docs/now.md\`；这份讲的是**怎么接手**。

## 这是什么

\`C:\\aitrpg\\poc\` —— 自主 AI RPG 引擎：模组机制编译为确定性、可验证的执行结构，
规则与状态由代码管理，LLM 只提出候选与叙事。**当前 HEAD**：${head}  ·  **测试**：${tests}

三条并行的局面驱动是**有意为之**，不是重复实现：
剧本杀（\`play-module.ts\`）／自由跑团（\`api/game-session.ts\`）／命令行（\`index.ts\`）。

${currentProductionIncrement}${currentProductionIncrement ? "\n\n" : ""}${checkpoint}${checkpoint ? "\n\n" : ""}## 第一件事：读这三份

\`\`\`
docs/now.md                          现在在哪（30 秒）
bun scripts/docs-index.ts todo warn  动手前要扫的坑
bun scripts/preflight.ts             跑一次，确认接手时是干净的
\`\`\`

**不要整份读 \`docs/architecture.json\`**（36KB）。用查询：

\`\`\`
bun scripts/docs-index.ts arch <关键词>    架构里找模块
bun scripts/docs-index.ts log <关键词>     查某问题记录过没有（搜正文）
\`\`\`

## 工作纪律（踩出来的，不是规范文档）

${rules.map((r: any, i: number) => `${i + 1}. ${r.text}`).join("\n\n")}

## 启动后端做实跑（模拟局/手动测试）

**不要**用 \`start "" /b bun run server > out.log 2> err.log\`——这条写法
两个毛病占全了：\`bun run server\` 是包装脚本，会再 spawn 一个子进程，
杀掉包装脚本后真正监听端口的那个变成孤儿；\`start /b\` 不脱离控制台，
子孙进程继承调用者的 stdout/stderr 句柄，等的是"管道关闭"不是"进程退出"，
工具会永远等不到 EOF、空转。正确用法已经写进仓库（这条已经在模拟 prompt
里丢过一次，模拟 prompt 每轮重写不算数，脚本才算）：

\`\`\`
bun run dev-server:start     启动，PID 落 .dev-server.pid，日志落 server-out.log / server-err.log
bun run dev-server:stop      按 PID 干净地杀掉，不留孤儿
bun run dev-server:status    看还在不在
\`\`\`

服务端口默认 **3099**（不是 3000），见 \`src/api/server.ts:1037\`，用环境变量
\`PORT\` 覆盖。脚本本体：\`scripts/dev-server.ps1\`。

## 提交信息（rule-04，只对新提交生效，不追溯历史）

subject 英文祈使句 + conventional 前缀（feat/fix/docs/test/refactor/chore）+
冒号 + 空格，**≤72 字符**；允许在 \`"..."\` 或「...」内引用中文术语/原文
（如 \`fix: "潜行" was listed as an attack verb\`）。空一行。body 每行 ≤72
字符手动换行——正文长不是问题，不换行才是（GitHub 不折行会横向滚动）。
**body 不用 markdown 粗体/斜体**：GitHub 提交消息不渲染 markdown，
\`**x**\` 会原样显示成星号；「」中文引号没问题。模板：\`.gitmessage\`
（生效需手动 \`git config commit.template .gitmessage\`，不随提交走）。

⚠ 「回到英文」不等于「兼容 GitHub」：已有 347 条英文历史提交里，最近
80 条的英文标题平均 82 字符、超 72 的占 55%——本身就不兼容这条规则，
只是没人量过。这条约定不追溯：历史提交（含 28 条中文，切换点
\`0880f75\`→\`9afbe9e\`，有意决策不是事故）一律不重写。

机器判据：\`.githooks/commit-msg\` + \`core.hooksPath\`，preflight 第 12 项
检查是否真的装上——没装上时这条纯靠人遵守，装了没配置和没装看不出区别。

## 环境坑

- **PowerShell 5.1**。仓库源码 UTF-8 **无 BOM**，\`Select-String\`/\`Get-Content\`
  读中文会 mojibake → 用 Read/Grep 工具或 \`fs.readFileSync\`
- \`bun run x.ts *> file\` 会把 UTF-8 写坏。诊断脚本一律走回调在内存收，
  自己 \`Bun.write\` 落盘。**曾因此得出「12 局 0 次触发」的假结论**
- \`git checkout <sha> -- <file>\` 会**同时改索引**。变异检验后用 \`Copy-Item\` 还原即可，
  多跑一句 \`git checkout HEAD --\` 会把未提交的改动冲掉（踩过）
- 测试**只有条数是可靠回归信号**，基线在 \`docs/test-baseline.json\`；
  \`expect()\` 计数会被无种子的随机测试搅动。已知两条偶发假红：
  \`coc-engine.test.ts:131\`、\`npc-reaction.test.ts\` 的「高稳定性减少负面情绪」
- \`typescript@7.0.2\` 是 native preview，\`require("typescript")\` **没有** \`createSourceFile\`。
  要解析 TS 就用 \`Bun.Transpiler\`（\`scanImports()\` 是真解析器）

## 验证手段（离线，不用 API key）

| 脚本 | 量什么 | 判据在哪 | 校准测试 |
|---|---|---|---|
| \`scripts/diag/diag-fuzz.ts\` | 通关率（= 正常返回**且**有正式结局）、死循环 | \`src/diagnostics/fuzz.ts\` | \`diag-fuzz.test.ts\` |
| \`scripts/diag/diag-wounds.ts\` | 伤势分级／重伤检定／惩罚骰 | \`src/diagnostics/wounds.ts\` | \`diag-wounds.test.ts\` |
| \`scripts/diag/diag-combat.ts\` | Boss 还手（按攻击者身份，不按技能名）、玩家掉血 | \`src/diagnostics/combat.ts\` | \`diag-combat.test.ts\` |
| \`scripts/diag/diag-downed.ts\` | 昏迷期间本人是否还在**掷骰** | \`src/diagnostics/downed.ts\` | \`diag-downed.test.ts\` |
| \`scripts/diag/diag-phrasing.ts\` | 玩家说法能否匹配到场景 | \`src/diagnostics/phrasing.ts\` | \`diag-phrasing.test.ts\` |
| \`scripts/diag/audit-backup.ts\` | 哪些数据丢了不可再生 | \`src/diagnostics/backup-classify.ts\` | \`diag-backup-classify.test.ts\` |
| \`scripts/diag/probe-llm.ts\` | LLM 通不通（**实际发一次请求**） | — | — |
| \`scripts/diag/probe-llm-move.ts\` | LLM 消歧值不值得接（重点是它肯不肯说「说不准」） | — | — |

⚠ 上面五个跑局脚本都写死 \`LLM_DISABLED=true\` —— **它们量的是离线行为**。
这不是缺陷（要可复现），但别把结论当成「整个引擎都这样」。
判断 LLM 通不通**必须实际发一次请求**：\`bun scripts/diag/probe-llm.ts\`。
\`bun test\` 输出里那句 \`[config] No LLM_API_KEY set\` 是**测试在验证无 key 的降级路径**，
跟真实可用性无关，最容易被当成证据。

⚠ **这些判据本身出过六次错**（详见 \`docs/review-request.md\`）。已做的返工：

1. **判据与脚本分开**。判断逻辑抽成纯函数放 \`src/diagnostics/\`（入库、可测），
   \`scripts/diag/*\` 只负责跑局和排版。早先脚本本体放在 \`tools/\`（.gitignore
   排除），判据留在那里等于没人守——后来整批搬进了 \`scripts/diag/\` 并入库。
2. **每条判据三种输入都有测试**：行为正确 → 通过；目标行为错误 → 失败；
   文本相似但合法 → 不误报。少了第二种就是「永远通过」，少了第三种就是「永远报警」。
3. **不再猜自然语言**。诊断读 \`src/play/events.ts\` 的结构化事件流，
   因为有些事实**文本里根本不存在**：重伤体质检定失败导致的昏迷没有 \`HP n → 0\` 那行，
   \`➜ 米戈 【格斗】\` 看不出攻击者是敌是我。补正则只会补出下一个假阳性。
4. **seed 现在控制整局**（\`src/diagnostics/run-harness.ts\` 接管 \`Math.random\`）。
   实测：同 seed 的事件流与播报文本**都可复现**，可作确定性回归依据。
   \`scripts/diag/diag-fuzz.ts\` 每次都把这条自检的结果打出来 —— 它是量出来的，不是声称的。

用它们之前仍然先确认能区分对错两种情形，别信「全绿」。
判据自己会说明三种「不算通过」的情形：
样本数为 0（没有可判的样本）、身份不可分辨（两名调查员重名）、以及本轮有异常局。

**这套判据上线后立刻报出真缺陷，都已修**（各带正/反/干扰三侧测试 + 变异检验）：

| 缺陷 | 谁报出来的 | 旧判据为什么看不见 |
|---|---|---|
| \`askCounts\` 模块级 Map 跨局残留 | fuzz 的复现自检 | 旧脚本没有复现自检 |
| 昏迷者还在掷「挣脱陷阱」 | downed | 那条昏迷路径没有 \`HP n → 0\` 播报 |
| 昏迷的同伴还在掷急救 | downed | 同上（且两人重名时无法归属） |
| 战斗攻击不读伤势惩罚 | wounds 的惩罚骰分账 | 旧判据数 \`/惩罚骰/\` 行数，疲劳的照样计数 |
| 两名调查员可能重名 | downed 的身份不可分辨检测 | 名字是日志里唯一的身份标记 |

用法：跑局类脚本都收 \`[局数] [起始局号]\`，
\`bun scripts/diag/diag-downed.ts 3 4\` = 第 4~6 局，便于分批跑而不重叠。

## 手上还挂着的（${openItems.length}）

${openItems.map((o: any) => `- ${o.title}\n  \`${o.file}:${o.line}\``).join("\n")}

## 最近做了什么

${recent.map((r) => "- " + r).join("\n")}

## 代码地图

拆分之后 \`play-module.ts\` 只剩骨架（车卡／世界初始化／主 while／结局结算）：

| 文件 | 装什么 |
|---|---|
| \`play/scene-pipeline.ts\` | 一次进场的完整流水线（进场→NPC→对话→线索→选下一步） |
| \`play/npc-dialogue.ts\` | 对话生成 |
| \`play/clue-check.ts\` | 线索检定（skill 优先、failback 兜底） |
| \`play/traps.ts\` / \`combat.ts\` | 陷阱 / Boss 战 |
| \`play/checks.ts\` | 检定、伤势、伤害 |
| \`play/run-state.ts\` | 本局状态，按「谁在写」分组（Cast/Cursor/Dedup/WorldModelCtx） |
| \`play/narration.ts\` | 播报输出层 |

**依赖单向**：\`play-module → play/*\`。子模块反向 import 就是环，
preflight 会报（tsc 不报）。
`;

// Exit success means the snapshot was written, not that its test child passed.
writeFileSync("docs/handoff.md", md, "utf8");
console.log(`docs/handoff.md 已生成 —— ${md.split("\n").length} 行 / ${(md.length / 1024).toFixed(1)} KB`);
if (testFailureDiagnostics.length) {
  console.log("\n  bun test bounded failure context:");
  for (const line of testFailureDiagnostics) console.log("    " + line);
}
