// 把「丢了就没了」的那部分打包出去。
//
// risk-01：C:\aitrpg 下只有 poc/ 有远端，其余 3.7GB 无版本控制无备份。
// 但不必全备 —— 分层之后不可再生的只有 ~489MB（源材料 + 手写设计 + 脚本），
// 其余 3.2GB 是抽取产物，源材料和脚本都在就能重跑。
//
// 用法：
//   bun scripts/backup-critical.ts --dry          只列清单和大小
//   bun scripts/backup-critical.ts --out D:\bak   真的复制过去
//
// 复制而不是压缩：这些多半已经是压缩格式（epub/pdf/docx），
// 再压一遍省不下多少，却让「随手翻一个文件出来看」变麻烦。

import { readdirSync, statSync, lstatSync, mkdirSync, copyFileSync, existsSync, writeFileSync } from "fs";
import { join, extname, dirname } from "path";

const ROOT = "C:\\aitrpg";
const outArg = process.argv.indexOf("--out");
const OUT = outArg >= 0 ? process.argv[outArg + 1] : "";
const dry = !OUT || process.argv.includes("--dry");

/** 不可再生 = 外部拿来的、人手写的、以及生成它们的脚本 */
function isCritical(p: string, name: string): string | null {
  const rel = p.replace(ROOT + "\\", "");
  const ext = extname(name).toLowerCase();

  if ([".pdf", ".docx", ".xlsx", ".epub", ".mobi"].includes(ext)) return "源材料";
  if (/来源|原著|raw|source/i.test(rel) && [".txt", ".json"].includes(ext)) return "源材料";

  // 直接躺在 世界模型\ 下的大 txt = 小说全文，是整条抽取链的根。
  // 按章切分的产物在 chapters_* / extracted_* 子目录里，不会命中。
  const depth = rel.split("\\").length;
  if (ext === ".txt" && depth === 2 && rel.startsWith("世界模型\\")) return "源材料";

  if ([".yaml", ".yml", ".md"].includes(ext)) return "手写设计";
  if ([".mjs", ".cjs", ".js", ".ts", ".py"].includes(ext)) {
    if (rel.includes("__pycache__")) return null;
    return "脚本";
  }
  return null;
}

interface Hit { src: string; rel: string; size: number; kind: string }
const hits: Hit[] = [];

function walk(dir: string, depth = 0) {
  if (depth > 8) return;
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (["node_modules", ".git", "dist", "__pycache__", ".pytest_cache"].includes(n)) continue;
    const p = join(dir, n);
    let st;
    try {
      // C:\aitrpg\世界模型 is a compatibility junction to the D: dataset.
      // Do not walk it a second time or backup the same corpus twice.
      if (lstatSync(p).isSymbolicLink()) continue;
      st = statSync(p);
    } catch { continue; }
    if (st.isDirectory()) { walk(p, depth + 1); continue; }
    const kind = isCritical(p, n);
    if (kind) hits.push({ src: p, rel: p.replace(ROOT + "\\", ""), size: st.size, kind });
  }
}

// poc 有远端，不重复备份
for (const n of readdirSync(ROOT)) {
  if (n === "poc") continue;
  const p = join(ROOT, n);
  try {
    if (statSync(p).isDirectory()) walk(p);
    else {
      const kind = isCritical(p, n);
      if (kind) hits.push({ src: p, rel: n, size: statSync(p).size, kind });
    }
  } catch { /* ignore */ }
}

const mb = (b: number) => (b / 1024 / 1024).toFixed(1);
const total = hits.reduce((a, h) => a + h.size, 0);

const byKind = new Map<string, { n: number; size: number }>();
for (const h of hits) {
  const c = byKind.get(h.kind) ?? { n: 0, size: 0 };
  c.n++; c.size += h.size; byKind.set(h.kind, c);
}

console.log(`不可再生：${hits.length} 个文件 / ${mb(total)} MB`);
for (const [k, v] of [...byKind.entries()].sort((a, b) => b[1].size - a[1].size)) {
  console.log(`  ${k.padEnd(6)} ${String(v.n).padStart(5)} 个  ${mb(v.size).padStart(8)} MB`);
}

if (dry) {
  console.log("\n--dry（或未给 --out），未复制。");
  console.log("真备份：bun scripts/backup-critical.ts --out D:\\aitrpg-backup");
  process.exit(0);
}

// 真复制。保持相对路径结构，方便原样还原。
let done = 0, skipped = 0;
for (const h of hits) {
  const dest = join(OUT, h.rel);
  try {
    if (existsSync(dest) && statSync(dest).size === h.size) { skipped++; continue; }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(h.src, dest);
    done++;
  } catch (e) {
    console.error(`  复制失败 ${h.rel}: ${e instanceof Error ? e.message : e}`);
  }
}

// 留一份清单，便于核对
const manifest = [
  `# 备份清单  ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
  `源：${ROOT}（不含 poc/，它有远端）`,
  `共 ${hits.length} 个文件 / ${mb(total)} MB`,
  "",
  ...hits.sort((a, b) => b.size - a.size).map((h) => `${mb(h.size).padStart(8)} MB  [${h.kind}]  ${h.rel}`),
].join("\n");
writeFileSync(join(OUT, "_manifest.txt"), manifest, "utf8");

console.log(`\n复制 ${done} 个，跳过 ${skipped} 个（已存在且大小相同）`);
console.log(`清单：${join(OUT, "_manifest.txt")}`);
