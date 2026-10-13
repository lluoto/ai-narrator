import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import * as diagnostics from "../diagnostics/source-scan";

type Result = { status?: number | null; signal?: string | null; error?: Error; stdout?: string; stderr?: string };
const full = "0 fail\nRan 3056 tests across 214 files";
const checkpoint = "## 编译闭环检查点 I 交接\n\nHandcrafted active compiler evidence.\n\n### Witnesses\n\nKeep these too.\n\n";

// Execute production bodies, replacing only imported IO and local process/console.
// No module/global mocks, subprocesses, or writes to the repository are involved.
function run(script: string, result: Result, query: "tests" | "unwired" | "hooks" = "tests", noTest = false,
  existingDocument = `# Existing\n\n${checkpoint}## 第一件事：读这三份\n\nOld generated content.`,
  todoItems: Array<Record<string, unknown>> = [], rawEvidenceError?: Error) {
  const writes = new Map<string, string>();
  const rawEvidenceResults: Result[] = [];
  const logs: string[] = [];
  const calls: string[] = [];
  let exit = 0;
  const files = new Map([
    ["docs/test-baseline.json", JSON.stringify({ tests: 3056, files: 214, unwiredMethods: 90 })],
    ["docs/handoff.md", existingDocument],
    ["docs/todo.json", JSON.stringify({ items: todoItems })],
    [".githooks/commit-msg", "fixture"],
  ]);
  const source = readFileSync(join(import.meta.dir, "../../scripts", script + ".ts"), "utf8")
    .replace(/^import\s[\s\S]*?from\s+["'][^"']+["'];\s*/gm, "")
    // The production body awaits the concurrent-drain helper. This harness
    // replaces imported process IO with an immediate fixture result.
    .replace("const t = await captureProcess(", "const t = captureProcess(")
    .replace("const evidence = await collectTestRunEvidence(", "const evidence = collectTestRunEvidence(");
  const bindings = {
    ...diagnostics, join,
    readFileSync: (path: string) => {
      if (!files.has(path)) throw new Error(`Unexpected read: ${path}`);
      return files.get(path)!;
    },
    existsSync: (path: string) => files.has(path),
    readdirSync: () => { throw new Error("Unexpected directory traversal"); },
    statSync: () => { throw new Error("Unexpected stat"); },
    writeFileSync: (path: string, text: string) => {
      if (path !== `docs/${script}.md`) throw new Error(`Unexpected write: ${path}`);
      writes.set(path, text);
    },
    spawnSync: (command: string, args: string[], options: { shell?: boolean }) => {
      const key = args.join(" ");
      const isTestCommand = args[0] === "test";
      calls.push(`${command} ${key}`);
      if (script !== "preflight") expect(options.shell).toBeUndefined();
      if ((query === "tests" && isTestCommand) ||
          (query === "unwired" && key === "scripts/diag/probe-unwired.ts") ||
          (query === "hooks" && key === "config --get core.hooksPath")) return result;
      if (isTestCommand) return { status: 0, stdout: full };
      if (key === "scripts/diag/probe-unwired.ts") return { status: 0, stdout: "没调用方 90" };
      if (key === "config --get core.hooksPath") return { status: 0, stdout: ".githooks" };
      return { status: 0, stdout: "" };
    },
    captureProcess: (command: string, args: string[]) => {
      const key = args.join(" ");
      calls.push(`${command} ${key}`);
      if (query === "tests") return result;
      return { status: 0, stdout: full, stderr: "" };
    },
    persistPreflightTestEvidence: (captured: Result) => {
      rawEvidenceResults.push(captured);
      if (rawEvidenceError) throw rawEvidenceError;
      const directory = `analysis/diag/preflight-bun-test-${rawEvidenceResults.length}`;
      writes.set(`${directory}/stdout.log`, captured.stdout ?? "");
      writes.set(`${directory}/stderr.log`, captured.stderr ?? "");
      return directory;
    },
    collectTestRunEvidence: (command: string, args: string[], baseline: diagnostics.TestBaseline) => {
      calls.push(`${command} ${args.join(" ")}`);
      const output = (result.stdout ?? "") + "\n" + (result.stderr ?? "");
      const count = diagnostics.parseTestOutput(output);
      const processVerdict = diagnostics.judgeProcess("bun test", result);
      const summary = diagnostics.judgeTestCount(count, baseline);
      return {
        ok: processVerdict.ok && summary.problems.length === 0,
        reason: processVerdict.ok ? summary.problems.join("；") : processVerdict.reason,
        output,
        count,
      };
    },
    process: { argv: noTest ? ["bun", script, "--no-test"] : ["bun", script], exit: (code: number) => { exit = code; } },
    console: { log: (text: string) => logs.push(text) },
  };
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  new Function(...Object.keys(bindings), js)(...Object.values(bindings));
  const text = writes.get(`docs/${script}.md`) ?? logs.join("\n");
  const summary = script === "preflight" ? text : text.split("\n").find((line) => script === "now" ? line.startsWith("| 测试 |") : line.includes("**测试**"))!;
  return { text, summary, exit, calls, writes, logs, rawEvidenceResults };
}

describe("production summary rendering", () => {
  for (const script of ["now", "handoff", "preflight"]) {
    test(`${script}: decoy failures cannot mask positive Bun summary`, () => {
      const r = run(script, { status: 0, stdout: "fixture: 0 failures", stderr: " 2 fail\r\nRan 3056 tests across 214 files [1.00s]\r\n" });
      expect(r.summary).not.toContain("全绿");
      expect(r.summary).toContain("2 条失败");
      expect(r.exit).toBe(script === "preflight" ? 1 : 0);
    });
    test(`${script}: decoy test/file counts do not replace real counts`, () => {
      const r = run(script, { status: 0, stdout: "fixture: Ran 9999 tests across 999 files", stderr: " 0 fail\nRan 3056 tests across 214 files [1.00s]" });
      expect(r.summary).toContain("3056 条 / 214 文件");
      expect(r.summary).not.toContain("9999");
      expect(r.exit).toBe(0);
    });
    test(`${script}: multiple exact summaries are ambiguous, never passing`, () => {
      const r = run(script, { status: 0, stdout: full, stderr: "2 fail\nRan 3056 tests across 214 files" });
      expect(r.summary).not.toContain("全绿");
      expect(r.summary).toContain("没解析到测试条数");
      expect(r.exit).toBe(script === "preflight" ? 1 : 0);
    });
  }
  for (const ending of ["", "\n", "\r\n"]) test(`handoff: checkpoint EOF separator ${JSON.stringify(ending)}`, () => {
    const section = "## 编译闭环检查点 I 交接\n\nKeep this evidence." + ending;
    const r = run("handoff", { status: 0, stdout: full }, "tests", false, "# Existing\n\n" + section);
    expect(r.text).toContain(section);
    expect(r.text).toMatch(/Keep this evidence\.\r?\n(?:\r?\n)*## 第一件事：读这三份/);
    expect(r.exit).toBe(0);
  });
  test("handoff: renders structured current production increment and preserves checkpoint", () => {
    const r = run("handoff", { status: 0, stdout: full }, "tests", false, undefined, [{
      id: "todo-64",
      latestPlayerDeliveryProgress: "P2 player-browser delivery scope",
      latestPlayerDeliveryVerification: "3500 tests / 261 files; Docker TLS proxy 未验收",
    }]);
    expect(r.text).toContain("## 当前生产化增量");
    expect(r.text).toContain("P2 player-browser delivery scope");
    expect(r.text).toContain("3500 tests / 261 files");
    expect(r.text).toContain("Docker TLS proxy 未验收");
    expect(r.text).toContain(checkpoint);
  });
  test("handoff: renders todo-65 handoff capture closure, verification, and open scope", () => {
    const closure = "handoff capture closure";
    const verification = "handoff capture verification";
    const openScope = "handoff capture open scope";
    const r = run("handoff", { status: 0, stdout: full }, "tests", false, undefined, [{
      id: "todo-65",
      handoffProcessCaptureClosure: closure,
      handoffProcessCaptureVerification: verification,
      handoffProcessCaptureOpenScope: openScope,
    }]);
    expect(r.text).toContain(closure);
    expect(r.text).toContain(verification);
    expect(r.text).toContain(openScope);
  });
  test("handoff: prioritizes only the allowlisted todo-65 durable replay increment", () => {
    const closure = "durable replay closure marker";
    const verification = "durable replay verification marker";
    const openScope = "durable replay open scope marker";
    const untrusted = "untrusted todo field must not render";
    const r = run("handoff", { status: 0, stdout: full }, "tests", false, undefined, [
      {
        id: "todo-64",
        compiledSessionCreationIngressClosure: "older current closure one",
        compiledSessionCreationIngressVerification: "older current verification one",
        compilerJsonIngressAdmissionClosure: "older current closure two",
        compilerJsonIngressAdmissionVerification: "older current verification two",
      },
      {
        id: "todo-65",
        handoffProcessCaptureClosure: "older current closure zero",
        handoffProcessCaptureVerification: "older current verification zero",
        compiledIntentDurableReplayClosure: closure,
        compiledIntentDurableReplayVerification: verification,
        compiledIntentDurableReplayOpenScope: openScope,
        untrusted,
      },
    ]);
    expect(r.text).toContain(closure);
    expect(r.text).toContain(verification);
    expect(r.text).toContain(openScope);
    expect(r.text).not.toContain(untrusted);
  });
  test("handoff: prioritizes the allowlisted todo-65 reverse-first-create increment", () => {
    const closure = "reverse first create closure marker";
    const verification = "reverse first create verification marker";
    const finalVerification = "reverse first create final verification marker";
    const openScope = "reverse first create open scope marker";
    const olderClosure = "older durable replay closure marker";
    const untrusted = "untrusted reverse-first-create todo field must not render";
    const r = run("handoff", { status: 0, stdout: full }, "tests", false, undefined, [{
      id: "todo-65",
      compiledIntentDurableReplayClosure: olderClosure,
      compiledIntentDurableReplayVerification: "older durable replay verification marker",
      compiledIntentDurableReplayOpenScope: "older durable replay open scope marker",
      worldRelationshipReverseFirstCreateClosure: closure,
      worldRelationshipReverseFirstCreateVerification: verification,
      worldRelationshipReverseFirstCreateFinalVerification: finalVerification,
      worldRelationshipReverseFirstCreateOpenScope: openScope,
      untrusted,
    }]);
    expect(r.text).toContain(closure);
    expect(r.text).toContain(finalVerification);
    expect(r.text).toContain(openScope);
    expect(r.text).toContain(olderClosure);
    expect(r.text.indexOf(closure)).toBeLessThan(r.text.indexOf(olderClosure));
    expect(r.text).not.toContain(verification);
    expect(r.text).not.toContain(untrusted);
  });
  test("handoff: prioritizes the durable current-round closure before existing todo-65 mappings", () => {
    const roundClosure = "durable current round closure marker";
    const roundVerification = "durable current round verification marker";
    const roundFinalVerification = "durable current round final verification marker";
    const roundScope = "durable current round open scope marker";
    const nowClosure = "now async drain closure marker";
    const nowVerification = "now async drain verification marker";
    const nowFinalVerification = "now async drain final verification marker";
    const nowScope = "now async drain open scope marker";
    const closure = "single active scene closure marker";
    const verification = "single active scene verification marker";
    const finalVerification = "single active scene final verification marker";
    const openScope = "single active scene open scope marker";
    const olderClosure = "older reverse-first-create closure marker";
    const olderScope = "older reverse-first-create open scope marker";
    const fourthClosure = "fourth bounded closure marker";
    const untrusted = "untrusted single-active-scene todo field must not render";
    const r = run("handoff", { status: 0, stdout: full }, "tests", false, undefined, [{
      id: "todo-65",
      worldDurableCurrentRoundSnapshotAtomicityClosure: roundClosure,
      worldDurableCurrentRoundSnapshotAtomicityVerification: roundVerification,
      worldDurableCurrentRoundSnapshotAtomicityFinalVerification: roundFinalVerification,
      worldDurableCurrentRoundSnapshotAtomicityOpenScope: roundScope,
      nowAsyncDrainClosure: nowClosure,
      nowAsyncDrainVerification: nowVerification,
      nowAsyncDrainFinalVerification: nowFinalVerification,
      nowAsyncDrainOpenScope: nowScope,
      worldSingleActiveSceneInvariantClosure: closure,
      worldSingleActiveSceneInvariantVerification: verification,
      worldSingleActiveSceneInvariantFinalVerification: finalVerification,
      worldSingleActiveSceneInvariantOpenScope: openScope,
      worldRelationshipReverseFirstCreateClosure: olderClosure,
      worldRelationshipReverseFirstCreateVerification: "older reverse-first-create verification marker",
      worldRelationshipReverseFirstCreateOpenScope: olderScope,
      compiledIntentDurableReplayClosure: "third bounded closure marker",
      compiledIntentDurableReplayVerification: "third bounded verification marker",
      handoffProcessCaptureClosure: fourthClosure,
      handoffProcessCaptureVerification: "fourth bounded verification marker",
      untrusted,
    }]);
    expect(r.text).toContain(roundClosure);
    expect(r.text).toContain(roundFinalVerification);
    expect(r.text).toContain(roundScope);
    expect(r.text).toContain(nowClosure);
    expect(r.text).toContain(nowFinalVerification);
    expect(r.text).toContain(nowScope);
    expect(r.text).toContain(closure);
    expect(r.text).toContain(finalVerification);
    expect(r.text).toContain(openScope);
    expect(r.text).toContain(olderClosure);
    expect(r.text).toContain(olderScope);
    expect(r.text.indexOf(roundClosure)).toBeLessThan(r.text.indexOf(nowClosure));
    expect(r.text.indexOf(nowClosure)).toBeLessThan(r.text.indexOf(closure));
    expect(r.text.indexOf(closure)).toBeLessThan(r.text.indexOf(olderClosure));
    expect(r.text.indexOf(roundScope)).toBeLessThan(r.text.indexOf(nowScope));
    expect(r.text.indexOf(nowScope)).toBeLessThan(r.text.indexOf(openScope));
    expect(r.text.indexOf(openScope)).toBeLessThan(r.text.indexOf(olderScope));
    expect(r.text).not.toContain(roundVerification);
    expect(r.text).not.toContain(nowVerification);
    expect(r.text).not.toContain(verification);
    expect(r.text).not.toContain(fourthClosure);
    expect(r.text).not.toContain(untrusted);
  });
  test("handoff: full tests use the drained-evidence boundary, never sync bun capture", () => {
    const r = run("handoff", { status: 0, stdout: full });
    expect(r.calls).toContain("bun test --parallel=1 --timeout 30000");
    expect(r.calls).not.toContain("bun test");
    const source = readFileSync(join(import.meta.dir, "../../scripts/handoff.ts"), "utf8");
    expect(source).not.toContain('spawnSync("bun", ["test"]');
  });
  test("now: full tests use the drained-evidence boundary, never sync bun capture", () => {
    const r = run("now", { status: 0, stdout: full });
    expect(r.calls).toContain("bun test --parallel=1 --timeout 30000");
    expect(r.calls).not.toContain("bun test");
    const source = readFileSync(join(import.meta.dir, "../../scripts/now.ts"), "utf8");
    expect(source).not.toContain('spawnSync("bun", ["test"]');
  });
  test("now: prioritizes durable current round while preserving active-scene and relationship mappings", () => {
    const roundClosure = "durable current round closure marker";
    const nowClosure = "now async drain closure marker";
    const activeClosure = "active-scene closure marker";
    const relationshipClosure = "relationship closure marker";
    const olderClosure = "older current closure marker";
    const nowScope = "now async drain open scope marker";
    const roundScope = "durable current round open scope marker";
    const activeScope = "active-scene open scope marker";
    const relationshipScope = "relationship open scope marker";
    const untrusted = "untrusted todo-65 field must not render";
    const r = run("now", { status: 0, stdout: full }, "tests", false, undefined, [
      { id: "todo-64", severity: "warn", compiledSessionCreationIngressClosure: olderClosure },
      {
        id: "todo-65",
        severity: "warn",
        worldDurableCurrentRoundSnapshotAtomicityClosure: roundClosure,
        worldDurableCurrentRoundSnapshotAtomicityOpenScope: roundScope,
        nowAsyncDrainClosure: nowClosure,
        nowAsyncDrainOpenScope: nowScope,
        worldSingleActiveSceneInvariantClosure: activeClosure,
        worldSingleActiveSceneInvariantOpenScope: activeScope,
        worldRelationshipReverseFirstCreateClosure: relationshipClosure,
        worldRelationshipReverseFirstCreateOpenScope: relationshipScope,
        legacyOrdinaryRuntimeInstallPrivateAuthorityOpenScope: "older todo-65 open scope marker",
        untrusted,
      },
    ]);
    expect(r.text).toContain(roundClosure);
    expect(r.text).toContain(nowClosure);
    expect(r.text).toContain(activeClosure);
    expect(r.text).toContain(relationshipClosure);
    expect(r.text.indexOf(roundClosure)).toBeLessThan(r.text.indexOf(nowClosure));
    expect(r.text.indexOf(nowClosure)).toBeLessThan(r.text.indexOf(activeClosure));
    expect(r.text.indexOf(activeClosure)).toBeLessThan(r.text.indexOf(relationshipClosure));
    expect(r.text.indexOf(relationshipClosure)).toBeLessThan(r.text.indexOf(olderClosure));
    expect(r.text.indexOf(roundScope)).toBeLessThan(r.text.indexOf(nowScope));
    expect(r.text.indexOf(nowScope)).toBeLessThan(r.text.indexOf(activeScope));
    expect(r.text.indexOf(activeScope)).toBeLessThan(r.text.indexOf(relationshipScope));
    expect(r.text).not.toContain(untrusted);
    const source = readFileSync(join(import.meta.dir, "../../scripts/now.ts"), "utf8");
    expect(source).toContain("legacyOrdinaryRuntimeInstallPrivateAuthorityOpenScope");
  });
  test("now and handoff: prioritize the allowlisted NPCAgent append, dispatch, Career, closed-lifecycle, player-session, and legacy WorldState increments", () => {
    const appendClosure = "NPCAgent memory append atomicity closure";
    const appendVerification = "NPCAgent memory append atomicity verification";
    const appendOpenScope = "npc-memory-append-scope";
    const npcClosure = "NPCAgent private dispatch closure";
    const npcVerification = "NPCAgent private dispatch verification";
    const npcOpenScope = "npc-agent-scope";
    const careerClosure = "career recovery closure";
    const careerVerification = "career recovery verification";
    const careerOpenScope = "career-scope";
    const writerClosure = "setScene writer retirement closure marker";
    const writerVerification = "setScene writer retirement verification marker";
    const writerOpenScope = "setScene writer retirement open scope marker";
    const worldFacadeClosure = "world facade lifecycle closure marker";
    const worldFacadeVerification = "world facade lifecycle verification marker";
    const worldFacadeOpenScope = "world facade lifecycle open scope marker";
    const lifecycleClosure = "closed lifecycle guard closure marker";
    const lifecycleVerification = "closed lifecycle guard verification marker";
    const lifecycleOpenScope = "closed-lifecycle-scope";
    const playerClosure = "player-session visible_to retirement closure marker";
    const playerVerification = "player-session visible_to retirement verification marker";
    const playerOpenScope = "player-scope";
    const closure = "legacy ownership closure marker";
    const verification = "legacy ownership verification marker";
    const finalVerification = "legacy ownership final verification marker";
    const openScope = "legacy-scope";
    const untrusted = "untrusted legacy ownership todo field must not render";
    const items = [{
      id: "todo-65",
      severity: "warn",
      npcMemoryAppendAtomicityClosure: appendClosure,
      npcMemoryAppendAtomicityVerification: appendVerification,
      npcMemoryAppendAtomicityOpenScope: appendOpenScope,
      npcAgentPrivateMemoryStateDispatchClosure: npcClosure,
      npcAgentPrivateMemoryStateDispatchVerification: npcVerification,
      npcAgentPrivateMemoryStateDispatchOpenScope: npcOpenScope,
      careerLeafLockDeadOwnerRecoveryClosure: careerClosure,
      careerLeafLockDeadOwnerRecoveryVerification: careerVerification,
      careerLeafLockDeadOwnerRecoveryOpenScope: careerOpenScope,
      gameSessionSetSceneWriterRetirementClosure: writerClosure,
      gameSessionSetSceneWriterRetirementVerification: writerVerification,
      gameSessionSetSceneWriterRetirementOpenScope: writerOpenScope,
      gameSessionWorldFacadeLifecycleClosure: worldFacadeClosure,
      gameSessionWorldFacadeLifecycleVerification: worldFacadeVerification,
      gameSessionWorldFacadeLifecycleOpenScope: worldFacadeOpenScope,
      gameSessionClosedLifecycleMutatorGuardClosure: lifecycleClosure,
      gameSessionClosedLifecycleMutatorGuardVerification: lifecycleVerification,
      gameSessionClosedLifecycleMutatorGuardOpenScope: lifecycleOpenScope,
      playerSessionVisibleToWriterRetirementClosure: playerClosure,
      playerSessionVisibleToWriterRetirementVerification: playerVerification,
      playerSessionVisibleToWriterRetirementOpenScope: playerOpenScope,
      legacyWorldStateReadOwnershipClosure: closure,
      legacyWorldStateReadOwnershipVerification: verification,
      legacyWorldStateReadOwnershipFinalVerification: finalVerification,
      legacyWorldStateReadOwnershipOpenScope: openScope,
      untrusted,
    }];
    const now = run("now", { status: 0, stdout: full }, "tests", false, undefined, items);
    const handoff = run("handoff", { status: 0, stdout: full }, "tests", false, undefined, items);

    expect(now.text).toContain(appendClosure);
    expect(now.text).toContain(npcClosure);
    expect(now.text).toContain(careerClosure);
    expect(now.text).toContain(writerClosure);
    expect(now.text).toContain(worldFacadeClosure);
    expect(now.text).toContain(lifecycleClosure);
    expect(now.text).toContain(playerClosure);
    expect(now.text).toContain(closure);
    expect(now.text.indexOf(appendClosure)).toBeLessThan(now.text.indexOf(npcClosure));
    expect(now.text.indexOf(npcClosure)).toBeLessThan(now.text.indexOf(careerClosure));
    expect(now.text.indexOf(careerClosure)).toBeLessThan(now.text.indexOf(writerClosure));
    expect(now.text.indexOf(writerClosure)).toBeLessThan(now.text.indexOf(worldFacadeClosure));
    expect(now.text.indexOf(worldFacadeClosure)).toBeLessThan(now.text.indexOf(lifecycleClosure));
    expect(now.text.indexOf(lifecycleClosure)).toBeLessThan(now.text.indexOf(playerClosure));
    expect(now.text.indexOf(playerClosure)).toBeLessThan(now.text.indexOf(closure));
    expect(now.text.indexOf(appendOpenScope)).toBeLessThan(now.text.indexOf(npcOpenScope));
    expect(now.text.indexOf(npcOpenScope)).toBeLessThan(now.text.indexOf(careerOpenScope));
    expect(now.text).not.toContain(appendVerification);
    expect(now.text.indexOf(careerOpenScope)).toBeLessThan(now.text.indexOf(writerOpenScope));
    expect(now.text).not.toContain(npcVerification);
    expect(now.text.indexOf(writerOpenScope)).toBeLessThan(now.text.indexOf(worldFacadeOpenScope));
    expect(now.text).not.toContain(careerVerification);
    expect(now.text.indexOf(worldFacadeOpenScope)).toBeLessThan(now.text.indexOf(lifecycleOpenScope));
    expect(now.text.indexOf(lifecycleOpenScope)).toBeLessThan(now.text.indexOf(playerOpenScope));
    expect(now.text.indexOf(playerOpenScope)).toBeLessThan(now.text.indexOf(openScope));
    expect(now.text).not.toContain(worldFacadeVerification);
    expect(now.text).not.toContain(writerVerification);
    expect(now.text).not.toContain(untrusted);

    expect(handoff.text).toContain(appendClosure);
    expect(handoff.text).toContain(appendVerification);
    expect(handoff.text).toContain(appendOpenScope);
    expect(handoff.text).toContain(npcClosure);
    expect(handoff.text).toContain(npcVerification);
    expect(handoff.text).toContain(npcOpenScope);
    expect(handoff.text).toContain(careerClosure);
    expect(handoff.text).toContain(careerVerification);
    expect(handoff.text).toContain(careerOpenScope);
    expect(handoff.text).toContain(writerClosure);
    expect(handoff.text).toContain(writerVerification);
    expect(handoff.text).toContain(writerOpenScope);
    expect(handoff.text).toContain(worldFacadeClosure);
    expect(handoff.text).toContain(worldFacadeVerification);
    expect(handoff.text).toContain(worldFacadeOpenScope);
    expect(handoff.text).toContain(lifecycleClosure);
    expect(handoff.text).toContain(lifecycleVerification);
    expect(handoff.text).toContain(lifecycleOpenScope);
    expect(handoff.text).toContain(playerClosure);
    expect(handoff.text).toContain(playerVerification);
    expect(handoff.text).toContain(playerOpenScope);
    expect(handoff.text).toContain(closure);
    expect(handoff.text).toContain(finalVerification);
    expect(handoff.text).toContain(openScope);
    expect(handoff.text.indexOf(appendClosure)).toBeLessThan(handoff.text.indexOf(npcClosure));
    expect(handoff.text.indexOf(appendVerification)).toBeLessThan(handoff.text.indexOf(npcVerification));
    expect(handoff.text.indexOf(appendOpenScope)).toBeLessThan(handoff.text.indexOf(npcOpenScope));
    expect(handoff.text.indexOf(npcClosure)).toBeLessThan(handoff.text.indexOf(careerClosure));
    expect(handoff.text.indexOf(npcVerification)).toBeLessThan(handoff.text.indexOf(careerVerification));
    expect(handoff.text.indexOf(npcOpenScope)).toBeLessThan(handoff.text.indexOf(careerOpenScope));
    expect(handoff.text.indexOf(careerClosure)).toBeLessThan(handoff.text.indexOf(writerClosure));
    expect(handoff.text.indexOf(careerVerification)).toBeLessThan(handoff.text.indexOf(writerVerification));
    expect(handoff.text.indexOf(careerOpenScope)).toBeLessThan(handoff.text.indexOf(writerOpenScope));
    expect(handoff.text.indexOf(writerClosure)).toBeLessThan(handoff.text.indexOf(worldFacadeClosure));
    expect(handoff.text.indexOf(writerVerification)).toBeLessThan(handoff.text.indexOf(worldFacadeVerification));
    expect(handoff.text.indexOf(writerOpenScope)).toBeLessThan(handoff.text.indexOf(worldFacadeOpenScope));
    expect(handoff.text.indexOf(worldFacadeClosure)).toBeLessThan(handoff.text.indexOf(lifecycleClosure));
    expect(handoff.text.indexOf(worldFacadeVerification)).toBeLessThan(handoff.text.indexOf(lifecycleVerification));
    expect(handoff.text.indexOf(worldFacadeOpenScope)).toBeLessThan(handoff.text.indexOf(lifecycleOpenScope));
    expect(handoff.text.indexOf(lifecycleClosure)).toBeLessThan(handoff.text.indexOf(playerClosure));
    expect(handoff.text.indexOf(playerClosure)).toBeLessThan(handoff.text.indexOf(closure));
    expect(handoff.text.indexOf(lifecycleOpenScope)).toBeLessThan(handoff.text.indexOf(playerOpenScope));
    expect(handoff.text.indexOf(playerOpenScope)).toBeLessThan(handoff.text.indexOf(openScope));
    expect(handoff.text).not.toContain(verification);
    expect(handoff.text).not.toContain(untrusted);
  });
  test("now and handoff: failed tests write a red snapshot and print bounded failure context", () => {
    const unrelated = `UNRELATED_HANDOFF_CAPTURE_${"z".repeat(8 * 1024)}`;
    const stdout = [
      unrelated,
      "Error: first focused context",
      "(fail) handoff suite > first [1.00ms]",
      unrelated,
      "Expected: second focused context",
      "(fail) handoff suite > second [1.00ms]",
      unrelated,
      "Received: third focused context",
      "(fail) handoff suite > third [1.00ms]",
      unrelated,
      "Error: fourth context must not render",
      "(fail) handoff suite > fourth [1.00ms]",
      "3052 pass",
      "4 fail",
      "Ran 3056 tests across 214 files [1.00s]",
    ].join("\n");
    for (const script of ["now", "handoff"]) {
      const r = run(script, { status: 1, stdout });
      const rendered = r.logs.join("\n");

      expect(r.exit).toBe(0);
      expect(r.writes.size).toBe(1);
      expect(r.text).toContain("测试未通过");
      expect(rendered).toContain("bun test bounded failure context:");
      expect(rendered).toContain("handoff suite > first");
      expect(rendered).toContain("Expected: second focused context");
      expect(rendered).toContain("handoff suite > second");
      expect(rendered).toContain("Received: third focused context");
      expect(rendered).toContain("handoff suite > third");
      expect(rendered).not.toContain(unrelated);
      expect(rendered).not.toContain("handoff suite > fourth");
    }
  });
  for (const todo of [
    { id: "todo-64", latestPlayerDeliveryProgress: "scope" },
    { id: "todo-64", latestPlayerDeliveryVerification: "verification" },
  ]) test(`handoff: missing current-increment field omits paragraph ${JSON.stringify(todo)}`, () => {
    const r = run("handoff", { status: 0, stdout: full }, "tests", false, undefined, [todo]);
    expect(r.text).not.toContain("## 当前生产化增量");
  });
  for (const script of ["now", "handoff"]) {
    test(`${script}: complete zero-failure success and checkpoint preservation`, () => {
      const r = run(script, { status: 0, stdout: full });
      expect(r.summary).toContain("全绿");
      expect(r.logs.join("\n")).not.toContain("bun test bounded failure context:");
      expect(r.exit).toBe(0);
      expect(r.writes.size).toBe(1);
      if (script === "handoff") expect(r.text).toContain(checkpoint);
    });
    for (const [name, result] of Object.entries({
      "missing failed": { status: 0, stdout: "Ran 3056 tests across 214 files" },
      "positive failed": { status: 0, stdout: "2 fail\nRan 3056 tests across 214 files" },
      "missing counts": { status: 0, stdout: "0 fail" },
      "nonzero": { status: 1, stdout: full },
      "signal": { status: 0, signal: "SIGTERM", stdout: full },
      "spawn error": { status: 0, error: new Error("fixture EPERM"), stdout: full },
      "null status": { status: null, stdout: full },
      "unknown status": { stdout: full },
    })) test(`${script}: ${name} never green, snapshot still generated`, () => {
      const r = run(script, result);
      expect(r.summary).not.toContain("全绿");
      expect(r.summary).toMatch(/未通过|完整摘要/);
      expect(r.writes.size).toBe(1);
      expect(r.exit).toBe(0);
    });
    test(`${script}: no-test is unrun`, () => {
      const r = run(script, { status: 0, stdout: full }, "tests", true);
      expect(r.text).toMatch(/未跑/);
      expect(r.summary).not.toContain("全绿");
      expect(r.calls).not.toContain("bun test");
    });
    if (script === "handoff") test("handoff: matching tests with fewer files is regression, not green", () => {
      const r = run(script, { status: 0, stdout: "0 fail\nRan 3056 tests across 213 files" });
      expect(r.summary).not.toContain("全绿");
      expect(r.summary).toContain("文件数回退");
    });
    if (script === "now") test("now: lower test count is regression, not green", () => {
      const r = run("now", { status: 0, stdout: "0 fail\nRan 3055 tests across 214 files" });
      expect(r.summary).not.toContain("全绿");
      expect(r.summary).toContain("测试条数回退");
    });
  }
});

describe("production preflight process checks", () => {
  test("valid unwired and hooks succeed", () => {
    expect(run("preflight", { status: 0, stdout: "没调用方 90" }, "unwired").exit).toBe(0);
  });
  for (const [name, outcome] of Object.entries({
    nonzero: { status: 2 }, signal: { status: 0, signal: "SIGTERM" },
    error: { status: 0, error: new Error("fixture EPERM") }, unknown: { status: null },
    missing: {},
  })) {
    test(`unwired ${name} rejects parseable partial output`, () => {
      const r = run("preflight", { ...outcome, stdout: "没调用方 90" }, "unwired");
      expect(r.exit).toBe(1);
      expect(r.text).toMatch(/probe-unwired.*(?:退出码|信号|启动)/);
      expect(r.text).not.toContain("断线 90 处，与基线一致");
    });
    for (const stdout of ["", ".githooks"]) test(`hooks ${name} rejects ${stdout || "empty"} output as lookup failure`, () => {
      const r = run("preflight", { ...outcome, stdout }, "hooks");
      expect(r.exit).toBe(1);
      expect(r.text).toMatch(/core.hooksPath.*(?:退出码|信号|启动)/);
      expect(r.text).not.toContain("跑一次 `git config");
      expect(r.text).not.toContain("commit-msg 判据在跑");
    });
  }
  test("unwired successful missing count is parsing failure", () => {
    const r = run("preflight", { status: 0, stdout: "truncated" }, "unwired");
    expect(r.exit).toBe(1);
    expect(r.text).toContain("解析不到条数");
  });
  test("hooks exit 1 empty is genuinely unset", () => {
    const r = run("preflight", { status: 1, stdout: "" }, "hooks");
    expect(r.exit).toBe(1);
    expect(r.text).toContain("(未设置)");
    expect(r.text).toContain("跑一次 `git config");
  });
  test("hooks exit 1 empty stdout with stderr is failed lookup", () => {
    const r = run("preflight", { status: 1, stdout: "", stderr: "error: lookup failed" }, "hooks");
    expect(r.exit).toBe(1);
    expect(r.text).toContain("lookup 退出码 1");
    expect(r.text).toContain("error: lookup failed");
    expect(r.text).not.toContain("跑一次 `git config");
    expect(r.text).not.toContain("(未设置)");
  });
  test("hooks exit 1 whitespace-only stderr remains unset", () => {
    const r = run("preflight", { status: 1, stdout: " \r\n", stderr: " \r\n" }, "hooks");
    expect(r.text).toContain("(未设置)");
    expect(r.text).toContain("跑一次 `git config");
  });
  test("hooks exit 1 partial is failed lookup", () => {
    const r = run("preflight", { status: 1, stdout: ".githooks" }, "hooks");
    expect(r.exit).toBe(1);
    expect(r.text).toContain("lookup 退出码 1");
    expect(r.text).not.toContain("commit-msg 判据在跑");
  });
  for (const [name, stdout, reason] of [
    ["missing failures", "Ran 3056 tests across 214 files", "失败数"],
    ["positive failures", "2 fail\nRan 3056 tests across 214 files", "2 条失败"],
    ["missing files", "0 fail\nRan 3056 tests", "测试条数"],
    ["regressed files", "0 fail\nRan 3056 tests across 213 files", "文件数回退"],
  ]) test(`preflight tests: ${name}`, () => {
    const r = run("preflight", { status: 0, stdout }, "tests");
    expect(r.exit).toBe(1);
    expect(r.text).toContain(reason!);
    expect(r.text).not.toContain("测试 3056 条 / 214 文件，与基线一致");
  });
  test("failed Bun run prints a bounded failing test name, not its full output", () => {
    const r = run("preflight", {
      status: 1,
      stdout: [
        "src/__tests__/transient.test.ts:",
        "  10 | expect(secretPayload).toBe(\"unexpected\");",
        "(fail) ordinary action serialization > keeps the retry receipt [1.00ms]",
        "3055 pass",
        "1 fail",
        "Ran 3056 tests across 214 files [1.00s]",
      ].join("\n"),
    }, "tests");
    expect(r.exit).toBe(1);
    expect(r.text).toContain("ordinary action serialization > keeps the retry receipt");
    expect(r.text).not.toContain("secretPayload");
  });
  test("preflight persists its same failed capture with complete separate streams before rendering bounded diagnostics", () => {
    const outcome = {
      status: 17, signal: null,
      stdout: "RAW_STDOUT_SENTINEL\n",
      stderr: 'error: expect(received).toMatchObject(expected)\n- Expected - 1\n- status: "sampled"\n+ Received + 1\n+ status: "refused"\n(fail) suite > raw diff\n3055 pass\n1 fail\nRan 3056 tests across 214 files\n',
    };
    const r = run("preflight", outcome);
    expect(r.rawEvidenceResults).toHaveLength(1);
    expect(r.rawEvidenceResults[0]).toBe(outcome);
    expect(r.writes.get("analysis/diag/preflight-bun-test-1/stdout.log")).toBe(outcome.stdout);
    expect(r.writes.get("analysis/diag/preflight-bun-test-1/stderr.log")).toBe(outcome.stderr);
    expect(r.calls.filter((call) => call.startsWith("bun test"))).toEqual(["bun test --parallel=1 --timeout 30000"]);
    expect(r.exit).toBe(1);
    expect(r.text).not.toContain("RAW_STDOUT_SENTINEL");
    expect(r.text).toContain("analysis/diag/preflight-bun-test-1");
  });
  test("preflight cannot turn an otherwise successful capture green when raw evidence persistence fails", () => {
    const r = run("preflight", { status: 0, signal: null, stdout: full, stderr: "" }, "tests", false, undefined, [], new Error("private disk error must not render"));
    expect(r.rawEvidenceResults).toHaveLength(1);
    expect(r.exit).toBe(1);
    expect(r.text).toContain("bun test 原始证据保存失败");
    expect(r.text).not.toContain("private disk error");
  });
  test("failed Bun diagnostics retain bounded contextual evidence for at most three failures", () => {
    const unrelated = `UNRELATED_BUN_CAPTURE_${"z".repeat(8 * 1024)}`;
    const stdout = [
      unrelated,
      "Error: first focused context",
      "(fail) suite > first [1.00ms]",
      unrelated,
      "Expected: second focused context",
      "(fail) suite > second [1.00ms]",
      unrelated,
      "Received: third focused context",
      "(fail) suite > third [1.00ms]",
      unrelated,
      "Error: fourth context must not render",
      "(fail) suite > fourth [1.00ms]",
      "3052 pass",
      "4 fail",
      "Ran 3056 tests across 214 files [1.00s]",
    ].join("\n");
    const r = run("preflight", {
      status: 1,
      stdout,
    }, "tests");
    const bounded = diagnostics.boundedBunFailureDiagnostics(stdout);
    const rendered = bounded.join("\n");

    expect(r.exit).toBe(1);
    expect(bounded.filter((line) => line.startsWith("bun test failure:"))).toHaveLength(3);
    expect(bounded.length).toBeLessThanOrEqual(diagnostics.BUN_FAILURE_CONTEXT_LIMITS.maxLines);
    expect(new TextEncoder().encode(rendered).byteLength).toBeLessThanOrEqual(diagnostics.BUN_FAILURE_CONTEXT_LIMITS.maxBytes);
    expect(rendered).toContain("Error: first focused context");
    expect(rendered).toContain("Expected: second focused context");
    expect(rendered).toContain("Received: third focused context");
    expect(rendered).not.toContain(unrelated);
    expect(r.text).toContain("bun test bounded failure context:");
    expect(r.text).toContain("suite > first");
    expect(r.text).toContain("suite > second");
    expect(r.text).toContain("suite > third");
    expect(r.text).not.toContain(unrelated);
    expect(r.text).not.toContain("suite > fourth");
  });
});

describe("authoritative Bun summary lines", () => {
  test("Bun terminal period before timing is accepted", () => {
    expect(diagnostics.parseTestOutput(" 0 fail\nRan 3056 tests across 214 files. [1.00s]"))
      .toEqual({ tests: 3056, files: 214, passed: null, skipped: null, failed: 0 });
  });
  test("decoy failure and count prose ignored", () => {
    expect(diagnostics.parseTestOutput("fixture: 0 failures\nfixture: Ran 9999 tests across 999 files\n 2 fail\nRan 3056 tests across 214 files [1.00s]"))
      .toEqual({ tests: 3056, files: 214, passed: null, skipped: null, failed: 2 });
  });
  for (const newline of ["\n", "\r\n"]) test(`trimmed exact summary ${JSON.stringify(newline)}`, () => {
    expect(diagnostics.parseTestOutput(` 0 fail ${newline} Ran 3056 tests across 214 files [1.00s] `))
      .toEqual({ tests: 3056, files: 214, passed: null, skipped: null, failed: 0 });
  });
  test("absent exact lines stay null", () => {
    expect(diagnostics.parseTestOutput("fixture: 0 failures\nfixture: Ran 3056 tests across 214 files\n0 failures\nRan 3056 tests across 214 files decoy"))
      .toEqual({ tests: null, files: null, passed: null, skipped: null, failed: null });
  });
  for (const extra of ["\n2 fail", "\nRan 1 tests across 1 files", "\n" + full]) test(`multiple exact evidence fails closed ${JSON.stringify(extra)}`, () => {
    expect(diagnostics.parseTestOutput(full + extra)).toEqual({ tests: null, files: null, passed: null, skipped: null, failed: null });
  });
});

describe("complete baseline evidence", () => {
  for (const cur of [
    { tests: 3056, files: 214, failed: null },
    { tests: 3056, files: null, failed: 0 },
    { tests: 3056, files: 213, failed: 0 },
  ]) test(`reject ${JSON.stringify(cur)}`, () => {
    expect(diagnostics.judgeTestCount(cur, { tests: 3056, files: 214 }).problems.length).toBeGreaterThan(0);
  });
});
