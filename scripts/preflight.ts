// 改动前后各跑一次的自检。把反复犯的几类错做成机器判据，别靠记性。
//
// 用法：
//   bun scripts/preflight.ts            全查
//   bun scripts/preflight.ts --quick    只查快的（跳过测试）
//
// 检查项：切割残渣 / 占位注释 / 反向 import / PowerShell 读中文 / typecheck /
//         测试条数基线 / 文档引用的脚本是否入库 / 丢掉的成功与否返回值 /
//         无声吞错的 catch / 源码引用的证据文件是否存在 / 断线的公开方法 /
//         提交信息 commit-msg 判据是否真的装上（core.hooksPath）
//
// ⚠ 这份脚本自己返工过一次。上一版六项检查里，**五项能被同一段坏代码骗过**：
//   1. 切割残渣：只认 `return|await|赋值` 四种起手式 → 函数头被删后留下
//      `register()` / `if` / `for` 一个都不报；同时不看花括号深度 →
//      合法函数里「JSDoc + return」被当成切歪（这是 174 个假阳性的来源）。
//   3. 循环依赖：正则 `from ["']\.\.\/play-module["']` → dynamic import、
//      带扩展名的路径、别名、`export ... from`、`require()` 全漏；
//      而注释和字符串里的 import 文本反倒会误报。
//   4. PowerShell 风险：只查 `.ts`、只认 `spawnSync`，命中之后还只放进
//      `notes`，脚本照样 `exit 0` —— 报了等于没报。
//   5. typecheck：只 grep stdout 里的 `error TS`。进程没起来、被信号杀掉、
//      或者 tsc 换个输出格式，三种情况都是「炸了但报绿」。
//   6. 测试条数：只 print，不跟任何基线比 —— 那不是回归检查。
//
// 判据都抽到了 `src/diagnostics/source-scan.ts`，每一项有「应报」「不应报」
// 两侧测试（`src/__tests__/diag-preflight-checks.test.ts`）。

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { captureProcess } from "../src/diagnostics/process-capture";
import { persistPreflightTestEvidence } from "../src/diagnostics/preflight-raw-evidence";
import {
  findTruncatedBlocks, findPlaceholderResidue, findReverseImports, findShellRisks,
  judgeProcess, parseTestOutput, judgeTestCount, boundedBunFailureDiagnostics,
  referencedScripts, judgeScriptRefs, generatedDocs, resolveRef,
  referencedRepoPaths, LIVE_DOCS,
  architecturePathRefs, ARCHITECTURE_DOCS,
  docSectionRefs, docHeadings, judgeDocSectionRefs,
  boolReturningNames, findDroppedReturns, findSilentCatches,
  type Finding, type TestBaseline,
} from "../src/diagnostics/source-scan";

const quick = process.argv.includes("--quick");
const problems: string[] = [];
const notes: string[] = [];
const testFailureDiagnostics: string[] = [];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".codegraph", ".superpowers"]);

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((x) => p.toLowerCase().endsWith(x))) out.push(p);
  }
  return out;
}

const read = (f: string) => readFileSync(f, "utf8"); // 中文源码必须走 fs，不能过 PowerShell
const push = (fs: Finding[]) => { for (const f of fs) problems.push(`${f.file}:${f.line}  ${f.message}`); };

const srcFiles = walk("src", [".ts"]);

// ── 1. 切割残渣：**顶层**块注释后面直接是语句 ──
//
// 收窄的关键是花括号深度必须为 0。深度 ≥ 1 的地方（接口字段、对象属性、
// switch case、联合类型续行、函数体内的说明）本来就允许注释后面跟非声明，
// 上一版没这一条，174 个假阳性淹掉 2 个真问题。
// 有了深度之后，判据可以反过来写：顶层注释后面**不是声明**就报，
// 于是 `register()` / `if` / `for` 这些残骸也一并认出来。
for (const f of srcFiles) push(findTruncatedBlocks(f, read(f)));

// ── 2. 搬运残渣：同一句占位注释出现多次 ──
for (const f of srcFiles) push(findPlaceholderResidue(f, read(f)));

// ── 3. 循环依赖：src/play/* 反向 import play-module ──
// 抽出来的模块反向 import 原文件就是环。tsc 不报，得自己看。
// 用 Bun 的解析器取 import（见 source-scan.scanImports）：静态/动态/require/
// `export ... from` 都认，注释与字符串里的 import 文本不认。
for (const f of srcFiles.filter((p) => p.includes("play") && !p.endsWith("play-module.ts"))) {
  push(findReverseImports(f, read(f), "play-module"));
}

// ── 4. 中文过 PowerShell ──
//
// 范围从「只有 scripts/*.ts」扩到仓库里真正在跑的脚本类型：
// `.ts/.js/.mjs/.cjs/.ps1`，覆盖 src、scripts、tools、frontend。
// `src/__tests__` 排除 —— 那里的坏样例是**判据的输入夹具**，不是真调用；
// 这条排除有明确理由，不是「让输出变绿」。
//
// 命中一律进 problems。上一版放进 notes 然后 exit 0，等于报了也没人拦。
const scriptExts = [".ts", ".js", ".mjs", ".cjs", ".ps1"];
const scriptFiles = [
  ...walk("src", scriptExts).filter((p) => !p.includes(join("src", "__tests__"))),
  ...walk("scripts", scriptExts),
  ...walk("tools", scriptExts),
  ...walk("frontend", scriptExts),
];
for (const f of scriptFiles) push(findShellRisks(f, read(f)));

// ── 8. 「成功与否」的返回值被丢掉 ──
//
// 「静默失败」在这个仓库有前科，docs/kp-tool-surface-assessment.md §八 记了两次，
// 原话是「类型检查与 710 个测试全绿，只有真实跑团暴露了它」。
// 这条检查第一次跑就逮到 `this.setScene(sceneId);` 两处 ——
// 而 `setActiveScene` 失败时会先清空全部 is_active，把世界弄成
// **一个活动场景都不剩**，比什么都没做更糟。
//
// 现在仓库里是 0 处，所以**不设豁免名单**：新增一处就红，
// 要么接住返回值，要么显式 `void`，要么说明白为什么可以不管。
{
  const scanned = [...srcFiles, ...walk("scripts", [".ts"])]
    .filter((p) => !p.includes(join("src", "__tests__")));
  const boolNames = new Set<string>();
  for (const f of scanned) for (const n of boolReturningNames(read(f))) boolNames.add(n);
  for (const f of scanned) push(findDroppedReturns(f, read(f), boolNames));
  notes.push(`返回 boolean 的实现 ${boolNames.size} 个，返回值被丢掉 0 处（超过 0 就会变成上面的问题）`);
}

// ── 9. 无声吞掉错误的 catch ──
//
// 空 catch 不是罪，**吞掉了却不说为什么**才是。
// 实跑第一次逮到 `mythos-module` 两处：`JSON.parse(exits)` 失败后照样
// 把空数组写回数据库，场景出口被静默抹掉 —— 正是 §八 记的那种事故。
// 修完是 0 处，同样不设豁免名单：写一行理由就能过，这个成本该付。
for (const f of [...srcFiles, ...walk("scripts", [".ts"])]) {
  push(findSilentCatches(f, read(f)));
}

// ── 7. 生成的文档叫人跑的脚本，仓库里得真有 ──
//
// `docs/handoff.md` 曾经整整一张表指着 `tools/_diag-*.ts`，而 `tools/`
// 在 .gitignore 里 —— 新克隆一个都没有。判据入了库、测试也齐了，
// 可跑它们的入口不在仓库里。这跟「判据看着在检查、其实什么也没量」
// 是同一类错，只是换了层皮，所以做成检查项。
//
// **只查脚本生成的那几份文档**：它们每次都会被重写，里面的每一句都必须
// 当下为真。`docs/notes/*.md` 是 append-only 的工作记录，
// 「当时用某个一次性脚本数出 4 处」是历史事实，那脚本后来删了不算缺陷。
// 不收窄的话第一次跑就是 43 个报告，其中 42 个来自 notes —— 又一次假阳性淹没真问题。
{
  const tracked = spawnSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // git ls-files 出来的就是正斜杠，不用归一化。
  const trackedPaths = (tracked.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const gitOk = !tracked.error && tracked.status === 0;
  // 磁盘候选：文档里可能写裸文件名/相对路径（`play/clue-check.ts`），
  // 得拿真实文件树去反查它落在哪个完整路径上。
  // ⚠ join() 在 Windows 上产出反斜杠，resolveRef 的 endsWith("/"+ref) 靠正斜杠
  //   分隔，不归一化这里会让「存在性」判断全量假阳性（永远判不存在）。
  const diskCandidates = [
    ...walk("src", [".ts", ".js", ".mjs", ".cjs"]),
    ...walk("scripts", [".ts", ".js", ".mjs", ".cjs"]),
    ...walk("tools", [".ts", ".js", ".mjs", ".cjs"]),
    ...walk("frontend", [".ts", ".js", ".mjs", ".cjs"]),
  ].map((p) => p.replace(/\\/g, "/"));
  const generated = generatedDocs(walk("scripts", [".ts"]).map(read));
  for (const doc of generated) {
    if (!existsSync(doc)) continue; // 还没生成过，不是这条检查的事
    const refs = referencedScripts(read(doc)).map((p) => ({
      path: p,
      exists: resolveRef(p, diskCandidates),
      // git 拿不到时不冤枉人：只查存在性，并在 notes 里说清楚
      tracked: gitOk ? resolveRef(p, trackedPaths) : true,
    }));
    push(judgeScriptRefs(refs, doc));
  }
  notes.push(`文档引用校验覆盖 ${generated.length} 份生成文档：${generated.join("、") || "(无)"}`);
  if (!gitOk) notes.push("git ls-files 不可用 —— 只校验了文档引用脚本是否存在，没校验是否入库");

  // ── 7b. 手写但载荷的文档：同一个病，换一批文档 ──
  //
  // 上面那截只查脚本生成的 3 份。另有 8 份手写文档被当成设计依据/验收标准
  // 引用（生产代码、测试注释都指着它们），但没有脚本重写过，路径一样会漂。
  //
  // 只查存在性、不查入库（tracked）—— tier-1 是叫人去"跑"的脚本，新克隆
  // 必须有；这几份是清单/评估文档，"里面写的东西还在不在"才是它的断言，
  // 跟入不入库无关。候选范围比 tier-1 多一个 docs/ 目录（引用范围也多了
  // docs/ 前缀），但同样只认脚本扩展名——见 referencedRepoPaths 的注释。
  const docCandidates = [
    ...walk("src", [".ts", ".js", ".mjs", ".cjs"]),
    ...walk("scripts", [".ts", ".js", ".mjs", ".cjs"]),
    ...walk("tools", [".ts", ".js", ".mjs", ".cjs"]),
    ...walk("frontend", [".ts", ".js", ".mjs", ".cjs"]),
    ...walk("docs", [".ts", ".js", ".mjs", ".cjs"]),
  ].map((p) => p.replace(/\\/g, "/"));
  let liveDocsChecked = 0;
  for (const doc of LIVE_DOCS) {
    if (!existsSync(doc)) continue;
    liveDocsChecked++;
    const refs = referencedRepoPaths(read(doc)).map((p) => ({
      path: p,
      exists: resolveRef(p, docCandidates),
      tracked: true, // tier-2 不判入库
    }));
    push(judgeScriptRefs(refs, doc));
  }
  notes.push(`手写载荷文档校验覆盖 ${liveDocsChecked} 份（只判存在性，不判入库）：${LIVE_DOCS.join("、")}`);

  // ── 7c. 结构化的手写载荷文档：architecture.json ──
  //
  // 同一个病的第三层皮：这份是 JSON，tier-1/tier-2 的正则（要么找
  // writeFileSync 目标、要么找反引号包裹的路径）都够不到它。按结构取
  // sections[].tables[].rows[][0]，跳过"工具脚本"节——见
  // architecturePathRefs 的注释。候选/存在性判法与 tier-2 一致，
  // 复用同一份 docCandidates，不用为多一份文档单独扫一次磁盘。
  let architectureDocsChecked = 0;
  for (const doc of ARCHITECTURE_DOCS) {
    if (!existsSync(doc)) continue;
    architectureDocsChecked++;
    const refs = architecturePathRefs(read(doc)).map((p) => ({
      path: p,
      exists: resolveRef(p, docCandidates),
      tracked: true, // 同 tier-2：只判存在性，不判入库
    }));
    push(judgeScriptRefs(refs, doc));
  }
  notes.push(`结构化载荷文档校验覆盖 ${architectureDocsChecked} 份（只判存在性，跳过"工具脚本"节）：${ARCHITECTURE_DOCS.join("、")}`);

  // ── 7d. 反向：文档引用文档的存在性 ──
  //
  // 前三层全部只查"文档引用的代码路径是否有效"这一个方向。文档引用
  // 另一份文档、或另一份文档的某个小节，完全没有判据覆盖——2026-08-29
  // 精简 docs/index-world-model.md 那一轮，docs/todo.json 与
  // docs/notes/ingest.md 各留了一处指向被删小节的死链，没有任何检查拦下。
  //
  // 只认规范写法 `` `docs/路径.md`「小节标题」``（见 docSectionRefs 的注释）；
  // 扫描范围是全部入库的 docs/**/*.md 加 docs/todo.json（后者是 JSON 字符串，
  // 直接当文本扫，正则一样能命中）。
  const docSourceFiles = [
    ...walk("docs", [".md"]),
    "docs/todo.json",
  ].filter((p) => existsSync(p));
  let docRefsChecked = 0;
  for (const doc of docSourceFiles) {
    const refs = docSectionRefs(read(doc));
    if (refs.length === 0) continue;
    docRefsChecked++;
    const verdicts = refs.map((ref) => {
      const fileExists = existsSync(ref.file);
      const sectionExists = fileExists && docHeadings(read(ref.file)).has(ref.section);
      return { ref, fileExists, sectionExists };
    });
    push(judgeDocSectionRefs(verdicts, doc));
  }
  notes.push(`文档互相引用校验（反向判据）覆盖 ${docRefsChecked} 份含小节引用的文档，规范写法之外的引用不在覆盖范围`);

  // ── 10. 源码拿来当证据的文件，仓库里得真有 ──
  //
  // 第 7 项管的是「文档叫人跑的脚本」，这一项管的是「代码引用的证据」。
  // 同一个病，另一层皮：四处注释写着「实跑原文见 play-logs/run-….txt」，
  // 而 `play-logs/` 在 .gitignore 里 —— **克隆下来的人根本打不开那个文件**。
  // 一句指向不存在之物的证据，读起来像有据可查，实际等于没有。
  //
  // 只认「路径样子的引用」：带目录分隔符且有扩展名。散文里提一句
  // 「见跑局日志」不算，那没许诺具体哪一份。
  //
  // ⚠ **不查 `analysis/`**。判据第一版把它算进来，报出 4 条全是误报：
  //   那是各个探针在 console.log 里声明自己的产物路径。
  //   `analysis/` 的东西都能由一个点得出名字的脚本重跑再生，
  //   引用它不算「指向不存在之物」。真正查不回来的是
  //   `play-logs/`（一次性跑局原文）、`tools/`（历史草稿）、`data/`（本机库）。
  const EVIDENCE_REF = /(?:^|[\s(（「`])((?:play-logs|data|tools)\/[\w./-]+\.(?:txt|md|json|jsonl))/g;
  const srcFiles = [...walk("src", [".ts"]), ...walk("scripts", [".ts"])];
  for (const f of srcFiles) {
    const text = read(f);
    for (const m of text.matchAll(EVIDENCE_REF)) {
      const ref = m[1]!;
      const line = text.slice(0, m.index).split("\n").length;
      if (!existsSync(ref)) {
        push([{ file: f, line, rule: "evidence-missing", message: `引用的证据文件不存在：${ref}` }]);
      } else if (gitOk && !trackedPaths.includes(ref)) {
        push([{
          file: f, line, rule: "evidence-untracked",
          message: `证据没入库，别人克隆下来打不开：${ref}`
            + `（要么拷进 docs/evidence/ 并改引用，要么别在注释里点具体文件名）`,
        }]);
      }
    }
  }
}

// ── 5. typecheck ──
// 先看退出状态（error / signal / status），再看输出。
// 只 grep 输出的话，进程没起来时输出是空串，判据会当成「零个错」。
const tsc = spawnSync("bun", ["run", "typecheck"], { encoding: "utf8", shell: true });
const tscVerdict = judgeProcess("typecheck", tsc);
const tscOut = (tsc.stdout ?? "") + (tsc.stderr ?? "");
if (!tscVerdict.ok) {
  problems.push(tscVerdict.reason);
  const tsErrors = tscOut.split("\n").filter((l) => /error TS/.test(l));
  const syntax = tsErrors.filter((l) => /TS1\d{3}/.test(l));
  if (tsErrors.length) problems.push(`  输出里能认出 ${tsErrors.length} 条 error TS`);
  if (syntax.length) problems.push(`  其中 ${syntax.length} 条是**语法错** —— 通常意味着切歪了，不是缺 import`);
  for (const e of tsErrors.slice(0, 5)) problems.push("  " + e.trim());
} else {
  // 退出码 0 但输出里有 error TS = tsc 的行为变了，同样要拦
  const stray = tscOut.split("\n").filter((l) => /error TS/.test(l));
  if (stray.length) problems.push(`typecheck 退出码 0，输出里却有 ${stray.length} 条 error TS —— 判据与工具行为不一致，先查清楚`);
  else notes.push("typecheck 通过（退出码 0）");
}

// ── 6. 测试：退出状态 + 条数基线 ──
// 「只打印当前条数」不是检查 —— 跟什么比？有基线才有回归。
const BASELINE_PATH = "docs/test-baseline.json";
if (!quick) {
  // Full-run fixtures share filesystem, SQLite, and CPU-heavy PDF work. The
  // runner-level per-test default must be explicit on Bun's CLI; a preload
  // cannot configure other test files. The verified 200-receipt filesystem
  // fixture declares a bounded 30s local limit, so the CLI cap cannot be
  // shorter. Keep one reproducible worker and a finite 30s runner ceiling.
  const t = await captureProcess("bun", ["test", "--parallel=1", "--timeout", "30000"]);
  try {
    const rawEvidenceDirectory = persistPreflightTestEvidence(t);
    notes.push(`bun test 原始 stdout/stderr 与退出证据保存在 ${rawEvidenceDirectory}（本地忽略目录，不代替门禁判据）`);
  } catch {
    // Raw evidence is required for a reproducible diagnosis. Do not expose a
    // filesystem error's private detail or pretend a failed save was success.
    problems.push("bun test 原始证据保存失败 —— 本次门禁不能报告通过");
  }
  const text = (t.stdout ?? "") + "\n" + (t.stderr ?? "");
  const verdict = judgeProcess("bun test", t);
  const counts = parseTestOutput(text);

  if (!verdict.ok || (counts.failed ?? 0) > 0) {
    const diagnostics = boundedBunFailureDiagnostics(text);
    if (diagnostics.length) {
      testFailureDiagnostics.push(...diagnostics);
    } else {
      problems.push("bun test 失败，但 Bun 输出中没有可解析的失败用例名（未重放完整测试输出）");
    }
  }

  if (!existsSync(BASELINE_PATH)) {
    problems.push(`缺少测试基线 ${BASELINE_PATH} —— 没有基线就没有回归检查；先跑一次并写入 {"tests":N,"files":M}`);
  } else {
    const base = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as TestBaseline;
    const r = judgeTestCount(counts, base);
    problems.push(...r.problems);
    notes.push(...r.notes);
  }
  // 退出码与条数是两条独立证据，都要看：
  // 条数对得上但进程非零退出（比如收尾时崩了）同样是坏的。
  if (!verdict.ok && (counts.failed ?? 0) === 0) {
    problems.push(`${verdict.reason}（输出里没解析到失败条数 —— 别因为「看着没 fail」就放过）`);
  } else if (!verdict.ok) {
    problems.push(verdict.reason);
  }
} else {
  notes.push("--quick：跳过测试与条数基线检查");
}

// ── 11. 断线：类的公开方法没有调用方 ──
//
// 这一轮反复撞见同一个病：**两端都写好了，中间那根线没接**。
//   · `NPCCombatEngine.getSanCost()`               遭遇修格斯 = 遭遇野狗
//   · `InvestigationEngine.setDifficultyProfile()` 难度按钮按下去什么都没变
// 数据在、实现在，只差一句调用。不报错、不让测试变红，
// 只让「本该发生的事」安静地不发生。
//
// 现有的 `probe-dead-code` 抓不到 —— 它量的是**模块级导出**，
// 而这些是**类的公开方法**：类本身在用，只有那一个方法没人调。
// tsc 也不管（`noUnusedLocals` 不看公开方法）。
//
// ⚠ 判法是「**不许增长**」而不是「必须为 0」。
//   当前有 90 处，绝大多数是整套没接线的子系统（经济/派系/金融/法术/职业档案）——
//   要求清零等于要求现在把它们全删掉或全接上，那不是这一条该做的决定。
//   能守住的是：**别再新增**。哪天有人又写了一个没人调的 setter，这里会变红。
{
  const p = spawnSync("bun", ["scripts/diag/probe-unwired.ts"], { encoding: "utf8", shell: true });
  const verdict = judgeProcess("probe-unwired", p);
  const out = (p.stdout ?? "") + (p.stderr ?? "");
  const m = verdict.ok ? /没调用方\s*(\d+)/.exec(out) : null;
  if (!verdict.ok) {
    problems.push(verdict.reason);
  } else if (!m) {
    problems.push("断线判据没跑起来（probe-unwired 的输出里解析不到条数）—— 判据自己坏了也要变红");
  } else {
    const now = Number(m[1]);
    const base = existsSync(BASELINE_PATH)
      ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as { unwiredMethods?: number }).unwiredMethods
      : undefined;
    if (base === undefined) {
      problems.push(`${BASELINE_PATH} 里缺 unwiredMethods 基线 —— 没有基线就没有回归检查；当前是 ${now}`);
    } else if (now > base) {
      problems.push(
        `没有调用方的公开方法从 ${base} 涨到 ${now} —— 新写的能力没接上，` +
        `或者接线被改掉了。看 analysis/diag/probe-unwired.md`,
      );
    } else {
      notes.push(
        now < base
          ? `断线 ${base} → ${now}（少了 ${base - now} 处，记得把基线调下来）`
          : `断线 ${now} 处，与基线一致（判法是不许增长，不是必须为 0 —— 理由见 preflight 第 11 项）`,
      );
    }
  }
}

// ── 12. 提交信息约定的机器判据是否真的在跑（docs/todo.json rule-04）──
//
// `.githooks/commit-msg` 生效靠 `git config core.hooksPath .githooks`——
// 这条配置**不随提交走**，新 clone 下来默认不生效。一个可能没装上的
// hook，正是本仓反复修的那种「看着在检查、其实什么也没量」：装了和
// 没装，从提交历史上看不出区别。这条检查把「判据没在跑」本身变成
// 能被 preflight 抓到的事，不靠人记得去核对。
{
  const hooksPath = spawnSync("git", ["config", "--get", "core.hooksPath"], { encoding: "utf8", shell: true });
  const configured = (hooksPath.stdout ?? "").trim();
  const verdict = judgeProcess("git config core.hooksPath lookup", hooksPath);
  const stderr = (hooksPath.stderr ?? "").trim();
  const unset = hooksPath.status === 1 && !hooksPath.error && !hooksPath.signal && configured === "" && stderr === "";
  if (!verdict.ok && !unset) {
    problems.push(verdict.reason + (stderr ? `（stderr：${stderr}）` : ""));
  } else if (configured !== ".githooks") {
    problems.push(
      `core.hooksPath 没有指向 .githooks（当前：「${configured || "(未设置)"}」）—— ` +
      `commit-msg 判据没有真的在跑。跑一次 \`git config core.hooksPath .githooks\`。`,
    );
  } else if (!existsSync(".githooks/commit-msg")) {
    problems.push("core.hooksPath 已指向 .githooks，但 .githooks/commit-msg 文件不存在——判据丢了。");
  } else {
    notes.push("core.hooksPath 已指向 .githooks，commit-msg 判据在跑（未装上时这条只能靠人遵守）。");
  }
}

// ── 输出 ──
console.log(problems.length === 0 ? "✓ preflight 通过" : `✗ preflight 发现 ${problems.length} 个问题`);
for (const p of problems) console.log("  " + p);
if (testFailureDiagnostics.length) {
  console.log("\n  bun test bounded failure context:");
  for (const line of testFailureDiagnostics) console.log("    " + line);
}
if (notes.length) {
  console.log("");
  for (const n of notes) console.log("  · " + n);
}
process.exit(problems.length ? 1 : 0);
