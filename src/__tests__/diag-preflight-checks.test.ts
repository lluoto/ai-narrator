// 判据校准：preflight 的六项检查。
//
// 每一项都要两侧测试 —— 「应报」和「不应报」。
// 只有「应报」的检查会退化成永远报警，只有「不应报」的会退化成永远通过，
// 两种都等于没检查。

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  maskSource, findTruncatedBlocks, findPlaceholderResidue,
  scanImports, importPointsTo, findReverseImports,
  findShellRisks, judgeProcess, parseTestOutput, judgeTestCount,
  boundedBunFailureDiagnostics, BUN_FAILURE_CONTEXT_LIMITS,
  referencedScripts, judgeScriptRefs, generatedDocs, resolveRef,
  referencedRepoPaths, LIVE_DOCS,
  architecturePathRefs, ARCHITECTURE_DOCS,
  docSectionRefs, docHeadings, judgeDocSectionRefs,
  boolReturningNames, findDroppedReturns, findSilentCatches,
} from "../diagnostics/source-scan";

// ── 底座：词法遮罩 ─────────────────────────────────────────────

describe("maskSource — 注释/字符串/正则不参与判据", () => {
  test("行注释与块注释被抹掉", () => {
    const m = maskSource(`const a = 1; // import x from "y"\n/* import z from "w" */\n`);
    expect(m.masked).not.toContain("import");
  });

  test("字符串内容被抹掉但长度与引号保留（偏移仍能换算行号）", () => {
    const src = `const s = "return 1";`;
    const m = maskSource(src);
    expect(m.masked.length).toBe(src.length);
    expect(m.masked).not.toContain("return 1");
    expect(m.strings[0]!.value).toBe("return 1");
  });

  test("**正则里的花括号不算深度** —— `/TS1\\d{3}/` 不该把后面的代码顶到嵌套层", () => {
    const src = `const re = /TS1\\d{3}/;\n/** doc */\nexport const x = 1;\n`;
    const m = maskSource(src);
    expect(m.blockComments[0]!.nest).toBe(0);
  });

  test("除号不会被当成正则开头", () => {
    const m = maskSource(`const half = total / 2;\nconst q = a / b;\n`);
    expect(m.masked).toContain("/ 2");
  });

  test("**函数参数上的 JSDoc 不是顶层** —— `()` 也要算嵌套层", () => {
    // 实跑在 `npc-reaction.ts` 上报过 4 个假阳性：只数 `{}` 时，
    // 带文档注释的函数参数被当成「顶层语句」。
    const src = [
      "export function f(",
      "  /** 力量对比 */",
      "  powerBalance: number = 0,",
      ") {",
      "  return powerBalance;",
      "}",
    ].join("\n");
    expect(maskSource(src).blockComments[0]!.nest).toBeGreaterThan(0);
    expect(findTruncatedBlocks("a.ts", src)).toEqual([]);
  });

  test("**模板字面量里的反引号与 `${}` 要按语法处理**", () => {
    // `scripts/handoff.ts` 生成 markdown：模板里既有 markdown 代码跨度的反引号，
    // 又有 `${...}` 表达式里的普通字符串。天真扫描会提前收尾，
    // 把后面的正文当代码，于是整段 markdown 被判成命令。
    const src = [
      "const md = `# 标题",
      "用 \\`bun x\\` 跑一次",
      '${items.map((r) => "- " + r).join("\\n")}',
      "`;",
      "/** doc */",
      "export const y = 1;",
    ].join("\n");
    const m = maskSource(src);
    expect(m.blockComments[0]!.nest).toBe(0);       // 模板已正确闭合，注释确实在顶层
    expect(findTruncatedBlocks("a.ts", src)).toEqual([]);
  });
});

// ── 检查 1：切割残渣 ───────────────────────────────────────────

describe("检查 1 · 切割残渣 — 应报", () => {
  test("顶层块注释后面直接是 `return`", () => {
    const f = findTruncatedBlocks("a.ts", `/**\n * doc\n */\nreturn value;\n`);
    expect(f.length).toBe(1);
    expect(f[0]!.rule).toBe("truncated-block");
  });

  test("**函数头被删后留下 `register()`** —— 上一版白名单只认 return/await/赋值，这条漏", () => {
    expect(findTruncatedBlocks("a.ts", `/** doc */\nregister();\n`).length).toBe(1);
  });

  test("**留下 `if`** —— 同样漏", () => {
    expect(findTruncatedBlocks("a.ts", `/** doc */\nif (ready) { go(); }\n`).length).toBe(1);
  });

  test("**留下 `for`** —— 同样漏", () => {
    expect(findTruncatedBlocks("a.ts", `/** doc */\nfor (const x of xs) { use(x); }\n`).length).toBe(1);
  });

  test("留下 `await` / 赋值（上一版能认的那几种也不能退化）", () => {
    expect(findTruncatedBlocks("a.ts", `/** doc */\nawait write(x);\n`).length).toBe(1);
    expect(findTruncatedBlocks("a.ts", `/** doc */\ntotal = total + 1;\n`).length).toBe(1);
  });
});

describe("检查 1 · 切割残渣 — 不应报", () => {
  test("**合法函数内 JSDoc 后接 return** —— 上一版的假阳性来源", () => {
    const src = [
      "export function f() {",
      "  /** 这段解释下面这句为什么这么写 */",
      "  return 1;",
      "}",
    ].join("\n");
    expect(findTruncatedBlocks("a.ts", src)).toEqual([]);
  });

  test("接口字段上的文档注释（174 个假阳性的主力）", () => {
    const src = [
      "export interface X {",
      "  /** 字段说明 */",
      "  a: number;",
      "  /** 另一个 */",
      "  b: string;",
      "}",
    ].join("\n");
    expect(findTruncatedBlocks("a.ts", src)).toEqual([]);
  });

  test("对象字面量属性 / switch case / 联合类型续行", () => {
    const src = [
      "const o = {",
      "  /** p */",
      "  p: 1,",
      "};",
      "function g(k: string) {",
      "  switch (k) {",
      "    /** c */",
      '    case "a": return 1;',
      "  }",
      "}",
      "export type U =",
      "  /** 一支 */",
      '  | { t: "a" }',
      '  | { t: "b" };',
    ].join("\n");
    expect(findTruncatedBlocks("a.ts", src)).toEqual([]);
  });

  test("顶层注释后面是正常声明", () => {
    for (const decl of [
      "export function f() {}", "function f() {}", "const x = 1;",
      "class C {}", "interface I { a: 1 }", "type T = 1;",
      "export default f;", "import x from \"y\";", "async function g() {}",
      "@dec", "export const y = 2;",
    ]) {
      expect(findTruncatedBlocks("a.ts", `/** doc */\n${decl}\n`)).toEqual([]);
    }
  });

  test("注释与声明之间隔着空行和行注释", () => {
    expect(findTruncatedBlocks("a.ts", `/** doc */\n\n// 补一句\nexport const x = 1;\n`)).toEqual([]);
  });

  test("文件结尾就是注释 → 不报", () => {
    expect(findTruncatedBlocks("a.ts", `export const x = 1;\n/** 尾注 */\n`)).toEqual([]);
  });
});

// ── 检查 2：搬运占位注释 ───────────────────────────────────────

describe("检查 2 · 占位注释残留", () => {
  const line = "// 已抽到 src/play/traps.ts（纯搬运）";
  test("应报：同一句出现两次以上", () => {
    expect(findPlaceholderResidue("a.ts", `${line}\ncode();\n${line}\n`).length).toBe(1);
  });
  test("不应报：只出现一次", () => {
    expect(findPlaceholderResidue("a.ts", `${line}\ncode();\n`)).toEqual([]);
  });
});

// ── 检查 3：反向 import ────────────────────────────────────────

describe("检查 3 · 反向 import — 应报", () => {
  test("静态 import", () => {
    expect(findReverseImports("p.ts", `import { a } from "../play-module";`, "play-module").length).toBe(1);
  });

  test("**dynamic import**（上一版漏）", () => {
    expect(findReverseImports("p.ts", `const m = await import("../play-module");`, "play-module").length).toBe(1);
  });

  test("**带扩展名的路径**（上一版漏）", () => {
    expect(findReverseImports("p.ts", `import { a } from "../play-module.ts";`, "play-module").length).toBe(1);
    expect(findReverseImports("p.ts", `import { a } from "../play-module.js";`, "play-module").length).toBe(1);
  });

  test("**别名路径**（上一版漏）", () => {
    expect(findReverseImports("p.ts", `import { a } from "@/play-module";`, "play-module").length).toBe(1);
    expect(findReverseImports("p.ts", `import { a } from "~/src/play-module";`, "play-module").length).toBe(1);
  });

  test("**`export ... from`**（上一版漏）", () => {
    expect(findReverseImports("p.ts", `export { a } from "../play-module";`, "play-module").length).toBe(1);
  });

  test("**`require()`**（上一版漏）", () => {
    expect(findReverseImports("p.cjs", `const a = require("../play-module");`, "play-module").length).toBe(1);
  });
});

describe("检查 3 · 反向 import — 不应报", () => {
  test("**注释里的 import 文本**（上一版会误报）", () => {
    const src = [
      '// 别写 import { x } from "../play-module"，那会成环',
      '/* import { y } from "../play-module"; */',
      'export const z = 1;',
    ].join("\n");
    expect(findReverseImports("p.ts", src, "play-module")).toEqual([]);
  });

  test("**字符串里的 import 文本**（上一版会误报）", () => {
    const src = `const tip = 'import { x } from "../play-module"';\n`;
    expect(findReverseImports("p.ts", src, "play-module")).toEqual([]);
  });

  test("名字相近但不是同一个模块", () => {
    expect(findReverseImports("p.ts", `import { a } from "../play-module-utils";`, "play-module")).toEqual([]);
    expect(findReverseImports("p.ts", `import { a } from "./narration";`, "play-module")).toEqual([]);
  });

  test("type-only import 不算运行时环（语义正确，不是漏报）", () => {
    expect(findReverseImports("p.ts", `import type { A } from "../play-module";`, "play-module")).toEqual([]);
  });

  test("importPointsTo 的边界", () => {
    expect(importPointsTo("../play-module", "play-module")).toBe(true);
    expect(importPointsTo("../play-module.mjs", "play-module")).toBe(true);
    expect(importPointsTo("../play-modules", "play-module")).toBe(false);
    expect(importPointsTo("../x/play-module/index", "play-module")).toBe(false);
  });

  test("scanImports 能同时认出四种形态", () => {
    const src = [
      'import a from "m1";',
      'const b = await import("m2");',
      'const c = require("m3");',
      'export { d } from "m4";',
    ].join("\n");
    const paths = scanImports(src).map((r) => r.path).sort();
    expect(paths).toEqual(["m1", "m2", "m3", "m4"]);
  });
});

// ── 检查 4：中文过 PowerShell ─────────────────────────────────

describe("检查 4 · PowerShell 读中文 — 应报", () => {
  test("execSync 里的 Get-Content 管道", () => {
    const src = `execSync("Get-Content src/a.ts | Select-String foo");`;
    expect(findShellRisks("s.ts", src).length).toBeGreaterThan(0);
  });

  test("**`Bun.spawn`**（上一版只认 spawnSync）", () => {
    const src = `Bun.spawn(["pwsh", "-c", "Get-Content src/a.ts"]);`;
    expect(findShellRisks("s.ts", src).length).toBeGreaterThan(0);
  });

  test("**`Bun.$` 模板串**", () => {
    const src = "await Bun.$`Get-Content src/a.ts | Select-String foo`;";
    expect(findShellRisks("s.ts", src).length).toBeGreaterThan(0);
  });

  test("**`.mjs` 文件也要查**（上一版只走 .ts）", () => {
    const src = `import { execSync } from "child_process";\nexecSync("Get-Content x.ts | Select-String y");`;
    expect(findShellRisks("s.mjs", src).length).toBeGreaterThan(0);
  });

  test("**`.ps1` 文件里的直接读取**（上一版完全不看）", () => {
    expect(findShellRisks("s.ps1", "Get-Content src\\a.ts | ForEach-Object { $_ }").length).toBe(1);
  });
});

describe("检查 4 · PowerShell 读中文 — 不应报", () => {
  test("**注释里提到这两个词**（判据不该咬自己）", () => {
    const src = `// 别用 Select-String / Get-Content 读中文源码，会 mojibake\nconst x = 1;`;
    expect(findShellRisks("s.ts", src)).toEqual([]);
  });

  test("**提示文案里提到**（不在命令位、没有管道）", () => {
    const src = `console.log("读中文请勿使用 Select-String");`;
    expect(findShellRisks("s.ts", src)).toEqual([]);
  });

  test("`.ps1` 的注释行", () => {
    expect(findShellRisks("s.ps1", "# 不要用 Get-Content 读中文")).toEqual([]);
  });

  test("正常的 fs.readFileSync 不报", () => {
    expect(findShellRisks("s.ts", `readFileSync("a.ts", "utf8");`)).toEqual([]);
  });

  test("**生成 markdown 的模板里提到这两个词**（handoff.ts / now.ts 的真实假阳性）", () => {
    // 竖线不能当判据 —— markdown 表格全是竖线。
    const src = [
      "const md = `# 接手说明",
      "",
      "| 脚本 | 量什么 |",
      "|---|---|",
      "| \\`tools/_diag-fuzz.ts\\` | 通关率 |",
      "",
      "- **PowerShell 5.1**。\\`Select-String\\`/\\`Get-Content\\` 读中文会 mojibake，",
      "  用 \\`fs.readFileSync\\`",
      "`;",
      'writeFileSync("docs/handoff.md", md, "utf8");',
    ].join("\n");
    expect(findShellRisks("handoff.ts", src)).toEqual([]);
  });

  test("同一个文件里若真去调命令，仍然要报（不是把整类放过）", () => {
    const src = [
      "const md = `- \\`Select-String\\` 会 mojibake`;",
      'execSync("Get-Content src\\\\a.ts | Select-String foo");',
    ].join("\n");
    expect(findShellRisks("handoff.ts", src).length).toBe(1);
  });
});

// ── 检查 7：文档引用的脚本必须存在且入库 ──────────────────────

describe("检查 7 · 文档叫人跑的脚本", () => {
  const doc = [
    "# 接手说明",
    "",
    "```",
    "bun scripts/preflight.ts             跑一次，确认接手时是干净的",
    "bun run scripts/diag/diag-fuzz.ts 3  随机玩法通关率",
    "```",
    "",
    "| 脚本 | 量什么 |",
    "|---|---|",
    "| `src/diagnostics/fuzz.ts` | 判据在这儿 |",
  ].join("\n");

  test("认得出 `bun x.ts` 与 `bun run x.ts` 两种写法", () => {
    expect(referencedScripts(doc)).toContain("scripts/preflight.ts");
    expect(referencedScripts(doc)).toContain("scripts/diag/diag-fuzz.ts");
  });

  test("**也要认表格里的反引号路径** —— 变异检验才逼出来的", () => {
    // 起初只认命令行，理由是「表格里的裸文件名是在说这个文件装什么」。
    // 第一次做变异检验就露馅：把 `diag-fuzz.ts` 从索引里撤掉，检查一声不吭 ——
    // handoff 那张表里六个脚本只有一个以命令行形态出现过。
    expect(referencedScripts(doc)).toContain("src/diagnostics/fuzz.ts");
  });

  test("**不应报**：不带反引号的裸文本才是「顺口提一句」", () => {
    expect(referencedScripts("正文里提到 scripts/nonexistent.ts 但没有强调也没叫人跑")).toEqual([]);
  });

  test("**应报**：文件不存在", () => {
    const f = judgeScriptRefs([{ path: "tools/_diag-fuzz.ts", exists: false, tracked: false }], "docs/handoff.md");
    expect(f.length).toBe(1);
    expect(f[0]!.rule).toBe("doc-script-missing");
  });

  test("**应报**：文件在但没入库 —— 新克隆拿不到", () => {
    // 这就是真事：`docs/handoff.md` 入了库，指着一整张表的 `tools/_diag-*.ts`，
    // 而整个 `tools/` 在 .gitignore 里。本机跑得动，别人克隆下来一个都没有。
    const f = judgeScriptRefs([{ path: "tools/_diag-fuzz.ts", exists: true, tracked: false }], "docs/handoff.md");
    expect(f.length).toBe(1);
    expect(f[0]!.rule).toBe("doc-script-untracked");
  });

  test("**不应报**：既存在又入库", () => {
    expect(judgeScriptRefs([{ path: "scripts/preflight.ts", exists: true, tracked: true }], "docs/x.md")).toEqual([]);
  });

  test("**范围收窄可推导**：只查脚本生成的文档", () => {
    // 不收窄的话第一次跑就是 43 个报告，其中 42 个来自 `docs/notes/*.md` ——
    // 又一次「假阳性淹掉真问题」。收窄的判据必须是可推导的：
    // 谁写这份文档，就由谁负责它当下为真。
    const scripts = [
      'writeFileSync("docs/handoff.md", md, "utf8");',
      'await Bun.write("docs/now.md", body);',
      'const notes = readFileSync("docs/notes/engine.md", "utf8");', // 只读不写 → 不算
    ];
    expect(generatedDocs(scripts).sort()).toEqual(["docs/handoff.md", "docs/now.md"]);
  });

  test("干扰：没有任何脚本写文档时返回空 —— 这条检查就自动不生效", () => {
    expect(generatedDocs(['console.log("docs/handoff.md")'])).toEqual([]);
  });

  test("干扰：文档里没有任何命令也没有反引号路径时不报", () => {
    expect(referencedScripts("# 标题\n\n一段正文，提到了 scripts/preflight.ts 但没强调。")).toEqual([]);
  });

  test("干扰：非脚本扩展名不算（`bun test` / `bun install`）", () => {
    expect(referencedScripts("```\nbun test\nbun install\nbun run typecheck\n```")).toEqual([]);
  });

  // ── 第二次变异检验：RUN_CMD / CODE_PATH 都要求 src|scripts|tools/ 前缀，
  //   于是裸文件名、src 内部相对路径、带行号的路径完全不被检查。
  //   preflight.ts 拿真实文件树当候选反查这三种写法，这里测反查本身。
  describe("resolveRef —— 裸路径/相对路径/带行号都要能反查到真实文件", () => {
    test("**不应报**：src 内部相对路径，候选里有完整 src 前缀", () => {
      expect(resolveRef("play/clue-check.ts", ["src/play/clue-check.ts"])).toBe(true);
    });

    test("**不应报**：__tests__ 目录同样靠候选反查", () => {
      expect(resolveRef("diag-fuzz.test.ts", ["src/__tests__/diag-fuzz.test.ts"])).toBe(true);
    });

    test("**不应报**：带 :行号 的引用——referencedScripts 先剥掉行号，resolveRef 再反查", () => {
      const refs = referencedScripts("参见 `coc-engine.test.ts:131`");
      expect(refs).toEqual(["coc-engine.test.ts"]);
      expect(resolveRef(refs[0]!, ["src/__tests__/coc-engine.test.ts"])).toBe(true);
    });

    test("**应报**：裸文件名在候选列表里没有任何后缀匹配", () => {
      // 就是本轮抓到的真事：docs/handoff.md 里的 `_diag-fuzz.ts`，
      // 磁盘上没有任何路径以 "/_diag-fuzz.ts" 结尾。
      expect(resolveRef("_diag-fuzz.ts", ["src/diagnostics/fuzz.ts", "scripts/other.ts"])).toBe(false);
    });

    test("干扰：不能只做子串匹配——同名但不同目录层级的文件不该互相冒认", () => {
      // "clue-check.ts" 不该被 "old-clue-check.ts" 之类的候选顶替；
      // resolveRef 要求 "/" + ref 精确收尾，不是随便包含。
      expect(resolveRef("clue-check.ts", ["src/play/old-clue-check.ts"])).toBe(false);
    });
  });

  // ── tier-2：preflight 第 7 项扩到手写但载荷的文档 ──
  //
  // 起因：手写文档（不是脚本生成的）也在被当成设计依据引用，但没有
  // `generatedDocs()` 那层保护——docs/index-world-model.md、
  // docs/kp-tool-surface-assessment.md 等 8 份。收窄规则：只认带仓库
  // 前缀（poc/、src/、scripts/、docs/、frontend/、tools/）**且带脚本
  // 扩展名**的反引号路径——第一版只做前缀收窄，把「目录」「历史对比用的
  // .md/.txt 数据文件」也当成引用检查，15 条报告里 14 条是这类噪声。
  describe("referencedRepoPaths —— tier-2 手写载荷文档的收窄规则", () => {
    test("**不应报**：poc/ 前缀能反查到仓库内真实文件", () => {
      const refs = referencedRepoPaths("参见 `poc/src/api/game-session.ts:1049`");
      expect(refs).toEqual(["src/api/game-session.ts"]);
      expect(resolveRef(refs[0]!, ["src/api/game-session.ts"])).toBe(true);
    });

    test("**不应报**：无前缀的裸文件名被跳过——这是收窄规则的核心", () => {
      // 跟 tier-1 的 referencedScripts 不一样：tier-1 里裸文件名要报
      // （`_diag-fuzz.ts` 就是这么抓到的），tier-2 反过来要跳过它——
      // 依据是 index-world-model.md:7 自己声明「非 poc/ 开头的路径
      // 跨出了 git 仓库」，没有前缀就不保证在仓库里，不该假装能验它。
      expect(referencedRepoPaths("参见 `_diag-fuzz.ts` 与 `some-random-name.ts`")).toEqual([]);
    });

    test("**应报**：带前缀但文件已不存在——本轮抓到的真事", () => {
      const refs = referencedRepoPaths("旧路径见 `tools/_audit-backup.ts`");
      expect(refs).toEqual(["tools/_audit-backup.ts"]);
      // 磁盘上真实存在的候选里没有任何一个以 "/tools/_audit-backup.ts" 结尾
      expect(resolveRef(refs[0]!, ["scripts/diag/audit-backup.ts"])).toBe(false);
    });

    test("干扰：目录引用（结尾是 /，没有扩展名）不算——那是在描述目录布局，不是文件是否存在", () => {
      expect(referencedRepoPaths("产物写到 `tools/modules/raw/` 目录下")).toEqual([]);
    });

    test("干扰：非脚本扩展名（.md/.txt）不算——历史对比记录本身就在断言\"这份不存在\"", () => {
      expect(referencedRepoPaths("对比 `src/module/calibration-report.md` 与 `src/module/raw/section_18.txt`")).toEqual([]);
    });

    test("LIVE_DOCS 清单齐了 8 份，且不含 rules-licensing-audit.md（那份按时点审计豁免）", () => {
      expect(LIVE_DOCS.length).toBe(8);
      expect(LIVE_DOCS).not.toContain("docs/rules-licensing-audit.md");
      expect(LIVE_DOCS).toContain("docs/index-world-model.md");
    });
  });

  // ── tier-3：architecture.json 是 JSON，tier-1/tier-2 的正则都够不到它 ──
  //
  // generatedDocs() 只匹配 docs/*.md 的 writeFileSync 目标，LIVE_DOC_PATH
  // 只认反引号包裹的路径——architecture.json 是 JSON，路径是结构化字段
  // 里的裸字符串，两条判据都扫不到它，107 个路径引用曾经无人守。
  describe("architecturePathRefs —— 按结构取 row[0]，不对全文跑正则", () => {
    function doc(sections: unknown[]): string {
      return JSON.stringify({ sections });
    }

    test("**应报**：活跃节里的坏路径——按结构取到 row[0]", () => {
      const refs = architecturePathRefs(doc([
        {
          title: "存储与状态",
          tables: [{ rows: [["src/state/game-state-manager.ts", "职责描述", "导出符号"]] }],
        },
      ]));
      expect(refs).toEqual(["src/state/game-state-manager.ts"]);
    });

    test("**不应报**：活跃节里的好路径", () => {
      const refs = architecturePathRefs(doc([
        {
          title: "存储与状态",
          tables: [{ rows: [["src/state/world-state-manager.ts", "真相源", "WorldStateManager"]] }],
        },
      ]));
      // 提取本身不判存在性（那是 preflight.ts 拿 resolveRef 做的事），
      // 这里只验证提取到了正确的路径，存在性判断在别处的测试覆盖。
      expect(refs).toEqual(["src/state/world-state-manager.ts"]);
    });

    test("**不应报**：「工具脚本」节里的坏路径——这是收窄规则的核心，必须有", () => {
      // 跳过依据可推导：该节标题自己写着"大部分仍在 tools/，被 .gitignore
      // 排除"——记录的是一次性取证脚本的历史存在，跟 docs/notes/*.md 的
      // 豁免同理。不跳过的话，tools/_cmp-raw.ts、tools/_followup-prompts.ts
      // 这类历史记录会被误报成路径失效。
      const refs = architecturePathRefs(doc([
        {
          title: "工具脚本（大部分仍在 `tools/`，被 .gitignore 排除）",
          tables: [{ rows: [["tools/_this-was-deleted-long-ago.ts", "历史记录", "无"]] }],
        },
      ]));
      expect(refs).toEqual([]);
    });

    test("**不应报**：散文里出现的路径——只取 row[0]，不扫 prose", () => {
      const refs = architecturePathRefs(JSON.stringify({
        sections: [
          {
            title: "存储与状态",
            prose: ["这一层原本是 src/state/deleted-long-ago.ts，后来拆成了现在这几个文件"],
            tables: [{ rows: [["src/state/world-state-manager.ts", "真相源", "WorldStateManager"]] }],
          },
        ],
      }));
      expect(refs).toEqual(["src/state/world-state-manager.ts"]);
    });

    test("干扰：第 1/2 列（职责描述、导出符号）里出现路径形状的文本不算，只取第 0 列", () => {
      const refs = architecturePathRefs(doc([
        {
          title: "某节",
          tables: [{
            rows: [["src/real/path.ts", "参见 src/other/mentioned-in-description.ts 的实现", "foo"]],
          }],
        },
      ]));
      expect(refs).toEqual(["src/real/path.ts"]);
    });

    test("干扰：反引号包裹的 row[0] 要先剥掉反引号再匹配（有的节这样写、有的节不这样写）", () => {
      const refs = architecturePathRefs(doc([
        { title: "某节", tables: [{ rows: [["`src/play-module.ts`", "跑一局剧本", "runModule"]] }] },
      ]));
      expect(refs).toEqual(["src/play-module.ts"]);
    });

    test("ARCHITECTURE_DOCS 清单目前只有 architecture.json 一份", () => {
      expect(ARCHITECTURE_DOCS).toEqual(["docs/architecture.json"]);
    });
  });
});

// ── tier-4（反向判据）：文档引用文档的存在性 ──
//
// 前三层全部只查"文档引用的代码路径是否有效"。这一层反过来：
// 2026-08-29 精简 docs/index-world-model.md 时，docs/todo.json 与
// docs/notes/ingest.md 各留了一处指向被删小节的死链，没有任何判据拦下。
// 复现的就是那两处真事：文件还在但小节没了、以及文件本身就没了。
describe("docSectionRefs / docHeadings / judgeDocSectionRefs —— tier-4 反向判据", () => {
  test("提取带反引号的规范写法", () => {
    const refs = docSectionRefs("分层依据见 `docs/archive-world-model-2026-08.md`「备份分层」。");
    expect(refs).toEqual([{ file: "docs/archive-world-model-2026-08.md", section: "备份分层" }]);
  });

  test("提取不带反引号的写法（todo.json 是 JSON 字符串，不方便嵌反引号）", () => {
    const refs = docSectionRefs("分层依据见 docs/archive-world-model-2026-08.md「备份分层」。");
    expect(refs).toEqual([{ file: "docs/archive-world-model-2026-08.md", section: "备份分层" }]);
  });

  test("干扰：只提一句文件名、不点小节的引用——判据故意看不见（收窄边界写在注释里）", () => {
    expect(docSectionRefs("详见 `docs/index-world-model.md`，别处再展开。")).toEqual([]);
  });

  test("docHeadings 认 1~6 级标题，去掉前导 # 与首尾空白", () => {
    const md = "# 标题\n\n正文\n\n## 二级 \n### 三级标题\n";
    expect(docHeadings(md)).toEqual(new Set(["标题", "二级", "三级标题"]));
  });

  test("**应报**：本仓真实踩过的两种断链，各复现一次", () => {
    // 复现 docs/todo.json 修复前的样子：引用的文件还在，但那个小节已经不在里面了
    // （原精简版把「备份分层」整节删掉，只剩「一句话现状」等标题）。
    const staleHeadings = docHeadings("# 标题\n\n## 一句话现状\n\n## 待办\n");
    const verdictSectionGone = {
      ref: { file: "docs/index-world-model.md", section: "备份分层" },
      fileExists: true,
      sectionExists: staleHeadings.has("备份分层"),
    };
    const findingsA = judgeDocSectionRefs([verdictSectionGone], "docs/todo.json");
    expect(findingsA.length).toBe(1);
    expect(findingsA[0]!.rule).toBe("doc-ref-missing-section");

    // 复现"文件本身就不存在"的那一半（变异检验用的另一侧）
    const verdictFileGone = {
      ref: { file: "docs/does-not-exist-2026.md", section: "任意小节" },
      fileExists: false,
      sectionExists: false,
    };
    const findingsB = judgeDocSectionRefs([verdictFileGone], "docs/notes/ingest.md");
    expect(findingsB.length).toBe(1);
    expect(findingsB[0]!.rule).toBe("doc-ref-missing-file");
  });

  test("**不应报**：小节标题逐字匹配", () => {
    const headings = docHeadings("## 备份分层：不必全备，只有 ~500MB 是不可再生的\n");
    const verdict = {
      ref: { file: "docs/archive-world-model-2026-08.md", section: "备份分层：不必全备，只有 ~500MB 是不可再生的" },
      fileExists: true,
      sectionExists: headings.has("备份分层：不必全备，只有 ~500MB 是不可再生的"),
    };
    expect(judgeDocSectionRefs([verdict], "docs/todo.json")).toEqual([]);
  });

  test("干扰：措辞近似但不逐字相同——有意判为断链，不做模糊匹配（见 docSectionRefs 注释第 3 条）", () => {
    const headings = docHeadings("## 备份分层：不必全备，只有~500MB是不可再生的\n"); // 少了两个空格
    const verdict = {
      ref: { file: "docs/archive-world-model-2026-08.md", section: "备份分层：不必全备，只有 ~500MB 是不可再生的" },
      fileExists: true,
      sectionExists: headings.has("备份分层：不必全备，只有 ~500MB 是不可再生的"),
    };
    const findings = judgeDocSectionRefs([verdict], "docs/todo.json");
    expect(findings.length).toBe(1);
    expect(findings[0]!.rule).toBe("doc-ref-missing-section");
  });
});

// ── 检查 8：「成功与否」的返回值被丢掉 ────────────────────────

describe("检查 8 · 丢掉的 boolean 返回值", () => {
  const src = [
    "class S {",
    "  setScene(id: string): boolean { return true; }",
    "  private ok(): boolean { return false; }",
    "  run() {",
    "    this.setScene('a');",        // 应报
    "    const r = this.setScene('b');", // 不应报：接了
    "    if (!this.setScene('c')) return;", // 不应报：判了
    "    return this.ok();",           // 不应报：返回了
    "  }",
    "}",
  ].join("\n");

  test("认得出返回 boolean 的**实现**", () => {
    expect(boolReturningNames(src).sort()).toEqual(["ok", "setScene"]);
  });

  test("**不应报**：接口成员声明不是实现", () => {
    // `isSceneVisited(id: string): boolean;` 长得跟调用很像 ——
    // 第一版扫出来两个假阳性就是它。判据看后面跟 `{` 还是 `;`。
    const iface = [
      "export interface MoveWorldView {",
      "  isSceneVisited(sceneId: string): boolean;",
      "  sceneExists(sceneId: string): boolean;",
      "}",
    ].join("\n");
    expect(boolReturningNames(iface)).toEqual([]);
  });

  test("**应报**：整行就是一次调用，返回值没人接", () => {
    const f = findDroppedReturns("s.ts", src, new Set(boolReturningNames(src)));
    expect(f.length).toBe(1);
    expect(f[0]!.rule).toBe("dropped-boolean-return");
    expect(f[0]!.message).toContain("setScene");
  });

  test("**不应报**：接了 / 判了 / 返回了", () => {
    const f = findDroppedReturns("s.ts", src, new Set(boolReturningNames(src)));
    expect(f.some((x) => x.message.includes("const r"))).toBe(false);
    expect(f.some((x) => x.message.includes("if ("))).toBe(false);
    expect(f.some((x) => x.message.includes("return this.ok"))).toBe(false);
  });

  test("**干扰**：注释与字符串里的同名调用不算", () => {
    const noisy = [
      "class S { setScene(id: string): boolean { return true; } }",
      "// this.setScene('x');",
      "const tip = \"this.setScene('y');\";",
    ].join("\n");
    expect(findDroppedReturns("s.ts", noisy, new Set(["setScene"]))).toEqual([]);
  });

  test("**干扰**：不返回 boolean 的方法不在范围内", () => {
    const other = "class S { log(m: string): void {} run() { this.log('x'); } }";
    expect(findDroppedReturns("s.ts", other, new Set(boolReturningNames(other)))).toEqual([]);
  });

  test("**干扰**：接口成员签名不是调用（真实假阳性，实跑逮到过）", () => {
    // `move-util.ts` 的 `MoveWorldView` 里有 `isSceneVisited(id: string): boolean;`，
    // 而 `world/state.ts` 真的实现了同名方法 —— 于是名字在集合里，
    // 那行签名就被报成「调用了但丢了返回值」。区别只在 `): X;` 这个返回类型标注。
    const iface = [
      "export interface MoveWorldView {",
      "  isSceneVisited(sceneId: string): boolean;",
      "  sceneExists(sceneId: string): boolean;",
      "}",
    ].join("\n");
    expect(findDroppedReturns("move-util.ts", iface, new Set(["isSceneVisited", "sceneExists"]))).toEqual([]);
  });

  test("真实源码中不同词法作用域的 helper 不会因全局 boolean 名称同名而误报", () => {
    const scanner = readFileSync(join(import.meta.dir, "..", "diagnostics", "source-scan.ts"), "utf8");
    const registry = readFileSync(join(import.meta.dir, "..", "world", "compiled-world-model-binding-registry.ts"), "utf8");
    const names = new Set([...boolReturningNames(scanner), ...boolReturningNames(registry)]);
    expect(findDroppedReturns("source-scan.ts", scanner, names)).toEqual([]);
  });
});

describe("检查 8 · 参数列表带嵌套括号（回调类型参数）——原判据的假绿来源", () => {
  // ⚠ 原正则是 `\([^()]*\)`（单层），本仓的处理器签名普遍带回调类型参数：
  //   `handleMove(intent: ActionIntent, msg: (s: string) => number): boolean {`
  // `(s: string)` 一层嵌套就让整条匹配失败——实测 game-session.ts 28 个真正
  // 返回 boolean 的方法里，单层正则只认得出 3 个（93% 漏判）。
  // findDroppedReturns 判"返回值被丢掉"全靠 boolNames.has(name)，认不出
  // 名字，判据对这些方法形同虚设——preflight 第 8 项报「0 处」是假绿。

  test("**错误行为的红线**：带回调类型参数的签名必须认得出", () => {
    const src = [
      "class S {",
      "  handleMove(intent: X, msg: (s: string) => number): boolean {",
      "    return true;",
      "  }",
      "}",
    ].join("\n");
    expect(boolReturningNames(src)).toContain("handleMove");
  });

  test("**正确**：两层嵌套（回调参数里还有回调）也认得出——不是换个数字的补丁", () => {
    const src = [
      "class S {",
      "  register(cb: (done: (ok: boolean) => void) => void): boolean {",
      "    return true;",
      "  }",
      "}",
    ].join("\n");
    expect(boolReturningNames(src)).toContain("register");
  });

  test("**干扰**：接口成员里带回调类型参数仍然不算实现（分号收尾）", () => {
    const iface = [
      "export interface Host {",
      "  tryResolveModuleScene(targetOrInput: string, msg?: (s: string) => void): boolean;",
      "}",
    ].join("\n");
    expect(boolReturningNames(iface)).toEqual([]);
  });

  test("**干扰**：if/while 这类控制流关键字不会被认成方法名", () => {
    const src = [
      "class S {",
      "  ok(cb: (x: string) => number): boolean { return true; }",
      "  run() {",
      "    if (this.ok((x) => x.length)) { return; }",
      "    while (this.ok((x) => x.length)) { break; }",
      "  }",
      "}",
    ].join("\n");
    const names = boolReturningNames(src);
    expect(names).toEqual(["ok"]);
    expect(names).not.toContain("if");
    expect(names).not.toContain("while");
  });

  test("端到端：game-session.ts 真实源码必须认出 ≥28 个返回 boolean 的方法", () => {
    // 用真实文件而不是构造夹具——单层正则在构造的小例子上也能看着对，
    // 本仓这次的假绿就是在真实、复杂签名上才现形的。
    const src = readFileSync(join(import.meta.dir, "..", "api", "game-session.ts"), "utf8");
    const names = boolReturningNames(src);
    expect(names.length).toBeGreaterThanOrEqual(28);

    // ⚠ 名单核实结果：题面给的 26 个名字里有 2 个经核实是错的，不是本次
    // 修复的问题——boolReturningNames 只扫 game-session.ts 这一份源码，
    // 扫不出定义在别处的方法：
    //   setActiveScene    —— 定义在 src/state/world-state-manager.ts:411，
//                        game-session.ts 里只有场景激活委托的调用点
    //   getPlayerInventory —— 同样定义在 world-state-manager.ts:213，
    //                        而且它返回 `string[]`，根本不是 boolean
    // 这两个不放进下面的断言列表，放了就是断言一件不成立的事。
    const verified26 = [
      "handleHelp", "tryResolveModuleScene", "handleMove", "handleInventory",
      "handleFlee", "handleRest", "handleSanCheck", "handleSkillCheck",
      "resolveSceneClue", "handleSavingThrow", "handleCreateCharacter",
      "handleListOccupations", "handleBuy", "handleLegacy", "handleGenerateStory",
      "handleLoadModule", "handleSkillAdvancement", "handleCast", "handleRead",
      "handleFirstAid", "handleReload", "handlePush", "handleChase",
      "handlePoliticoEconomy",
    ];
    expect(verified26.length).toBe(24); // 26 减掉核实有误的 2 个
    for (const name of verified26) {
      expect(names).toContain(name);
    }
  });

  test("端到端：setActiveScene 在它真正定义的文件（world-state-manager.ts）里能被认出——判据的原型案例本身要立得住", () => {
    // source-scan.ts 用 setActiveScene 当第 8 项判据的立案理由（"失败时会把
    // 世界弄成一个活动场景都不剩"），但判据从未在任何真实文件上验证过认得出
    // 它自己的原型案例。这里补上。
    const src = readFileSync(join(import.meta.dir, "..", "state", "world-state-manager.ts"), "utf8");
    expect(boolReturningNames(src)).toContain("setActiveScene");
  });
});

// ── 检查 9：无声吞掉错误的 catch ──────────────────────────────

describe("检查 9 · 无声吞错的 catch", () => {
  test("**应报**：空 catch 且一个字都没有", () => {
    const f = findSilentCatches("a.ts", "try { risky(); } catch {}");
    expect(f.length).toBe(1);
    expect(f[0]!.rule).toBe("silent-catch");
  });

  test("**应报**：带参数的空 catch 同样算", () => {
    expect(findSilentCatches("a.ts", "try { risky(); } catch (e) {}").length).toBe(1);
  });

  test("**不应报**：空体但写了理由 —— 判据问的是「说没说为什么」", () => {
    // `try { mkdirSync(d) } catch { /* 目录已存在 */ }` 完全合理。
    // 没有这一条，检查就变成「禁止空 catch」，那是另一回事，也没人会遵守。
    expect(findSilentCatches("a.ts", "try { mkdirSync(d); } catch { /* 目录已存在 */ }")).toEqual([]);
    expect(findSilentCatches("a.ts", "try { x(); } catch {\n  // 读不到就算了，下游有兜底\n}")).toEqual([]);
  });

  test("**不应报**：catch 里有语句（留了痕）", () => {
    expect(findSilentCatches("a.ts", "try { x(); } catch (e) { log.warn(e); }")).toEqual([]);
    expect(findSilentCatches("a.ts", "try { x(); } catch { return null; }")).toEqual([]);
  });

  test("**干扰**：字符串里出现 `catch {}` 不算", () => {
    expect(findSilentCatches("a.ts", 'const tip = "别写 catch {} 这种东西";')).toEqual([]);
  });

  test("**干扰**：注释里出现 `catch {}` 不算", () => {
    expect(findSilentCatches("a.ts", "// 反例：catch {}\nconst x = 1;")).toEqual([]);
  });

  test("嵌套 catch 各自独立判定", () => {
    const src = "try { try { a(); } catch {} } catch { /* 外层说明过了 */ }";
    expect(findSilentCatches("a.ts", src).length).toBe(1);
  });
});

// ── 检查 5：外部进程退出状态 ──────────────────────────────────

describe("检查 5 · spawnSync 结果判定", () => {
  test("**应报**：进程没起来（error 非空）", () => {
    const v = judgeProcess("typecheck", { error: new Error("spawn bun ENOENT"), status: null, stdout: "", stderr: "" });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("没能启动");
  });

  test("**应报**：被信号杀掉", () => {
    expect(judgeProcess("test", { status: null, signal: "SIGKILL" }).ok).toBe(false);
  });

  test("**应报**：退出码非零，即使 stdout 里一个 `error TS` 都没有", () => {
    // 上一版只 grep stdout：tsc 换输出格式、或者本地化之后就全绿。
    const v = judgeProcess("typecheck", { status: 2, stdout: "编译已完成，存在错误。", stderr: "" });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("退出码 2");
  });

  test("**应报**：没有退出码（状态未知）", () => {
    expect(judgeProcess("test", { status: null }).ok).toBe(false);
  });

  test("**不应报**：退出码 0", () => {
    expect(judgeProcess("typecheck", { status: 0, stdout: "", stderr: "" }).ok).toBe(true);
  });
});

// ── 检查 6：测试条数基线 ──────────────────────────────────────

describe("检查 6 · 测试条数基线", () => {
  const base = { tests: 1341, files: 66 };

  test("parseTestOutput 取得到条数与失败数", () => {
    const out = " 1341 pass\n 0 fail\nRan 1341 tests across 66 files. [40.30s]";
    expect(parseTestOutput(out)).toEqual({ tests: 1341, files: 66, passed: 1341, skipped: null, failed: 0 });
  });

  test("**应报**：条数比基线少（有测试被删/被跳过）", () => {
    const v = judgeTestCount({ tests: 1300, files: 66, failed: 0 }, base);
    expect(v.problems.some((p) => p.includes("回退"))).toBe(true);
  });

  test("**应报**：有失败", () => {
    const v = judgeTestCount({ tests: 1341, files: 66, failed: 2 }, base);
    expect(v.problems.some((p) => p.includes("2 条失败"))).toBe(true);
  });

  test("**应报**：解析不到条数 —— 不许当成通过", () => {
    // 上一版 `if (ran) notes.push(...)`：解析不到就什么也不做，静默变绿。
    const v = judgeTestCount({ tests: null, files: null, passed: null, skipped: null, failed: null }, base);
    expect(v.problems.length).toBeGreaterThan(0);
  });

  test("**不应报**：条数与基线一致且零失败", () => {
    const v = judgeTestCount({ tests: 1341, files: 66, failed: 0 }, base);
    expect(v.problems).toEqual([]);
  });

  test("**不应报但要提示**：条数变多 → 提醒更新基线", () => {
    const v = judgeTestCount({ tests: 1400, files: 70, failed: 0 }, base);
    expect(v.problems).toEqual([]);
    expect(v.notes.some((n) => n.includes("更新"))).toBe(true);
  });

  test("**应报**：通过数变成 skip，不能被相同总数掩盖", () => {
    const strict = { tests: 1341, files: 66, passed: 1309, skipped: 32 };
    const v = judgeTestCount({ tests: 1341, files: 66, passed: 1302, skipped: 39, failed: 0 }, strict);
    expect(v.problems).toContain("测试通过数变化：1302 ≠ 基线 1309");
    expect(v.problems).toContain("测试跳过数变化：39 ≠ 基线 32");
  });
});

describe("preflight · Bun failure context", () => {
  test("keeps a bounded diagnostic neighbourhood for every reported failure", () => {
    const unrelated = "ordinary suite log that must not be replayed";
    const output = [
      ...Array.from({ length: 80 }, () => unrelated),
      "error: expect(received).toBe(expected)",
      "Expected: \"open\"",
      "Received: \"closed\"",
      "      at src/__tests__/door.test.ts:41:19",
      "(fail) gate opens after a key [2ms]",
      ...Array.from({ length: 80 }, () => unrelated),
      "error: child process exited with code 17",
      "      at spawnChild (src/__tests__/child.test.ts:9:3)",
      "(fail) child failure is surfaced [3ms]",
      " 2 fail",
    ].join("\n");

    const diagnostics = boundedBunFailureDiagnostics(output);
    const rendered = diagnostics.join("\n");

    expect(rendered).toContain("gate opens after a key");
    expect(rendered).toContain("child failure is surfaced");
    expect(rendered).toContain("Expected: \"open\"");
    expect(rendered).toContain("Received: \"closed\"");
    expect(rendered).toContain("child process exited with code 17");
    expect(rendered).not.toContain(unrelated);
    expect(diagnostics.length).toBeLessThanOrEqual(BUN_FAILURE_CONTEXT_LIMITS.maxLines);
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(BUN_FAILURE_CONTEXT_LIMITS.maxBytes);
  });

  test("does not silently drop an identified failure whose nearby output has no diagnostic lines", () => {
    const diagnostics = boundedBunFailureDiagnostics("(fail) bare failing case [1ms]");
    expect(diagnostics.join("\n")).toContain("bare failing case");
    expect(diagnostics.join("\n")).toContain("no recognized diagnostic lines");
  });

  test("reserves bounded output for each failure when an assertion line is enormous", () => {
    const hugeError = `error: ${"界".repeat(10_000)}`;
    const output = Array.from({ length: 5 }, (_, index) => [
      hugeError,
      `(fail) failure ${index} [1ms]`,
    ].join("\n")).join("\n");
    const rendered = boundedBunFailureDiagnostics(output).join("\n");

    expect(rendered).toContain("failure 0");
    expect(rendered).toContain("failure 1");
    expect(rendered).toContain("failure 2");
    expect(rendered).not.toContain("failure 3");
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(BUN_FAILURE_CONTEXT_LIMITS.maxBytes);
    expect(rendered.split("\n").length).toBeLessThanOrEqual(BUN_FAILURE_CONTEXT_LIMITS.maxLines);
  });

  test("keeps bounded child-process diagnostics even when Bun did not print a failure name", () => {
    const diagnostics = boundedBunFailureDiagnostics([
      "error: spawn child ENOENT",
      "    at launch (runner.ts:12:5)",
      "bun test aborted before the summary",
    ].join("\n"));
    expect(diagnostics.join("\n")).toContain("Bun test process failure");
    expect(diagnostics.join("\n")).toContain("spawn child ENOENT");
  });
});
