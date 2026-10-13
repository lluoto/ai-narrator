// ============================================================
// 模组编辑器 — CRUD 模组 JSON 文件
// ============================================================

import { lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { isAbsolute, relative, resolve, sep } from "path";
import type { MythosModule } from "../rules/mythos-module";

const MODULES_DIR = resolve(process.cwd(), "data", "modules");
const MODULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Module IDs double as storage filenames, so they are deliberately one ASCII path segment. */
export function isSafeModuleId(value: unknown): value is string {
  return typeof value === "string" && MODULE_ID_PATTERN.test(value);
}

/** Validate both the declared identifier and the resolved storage containment. */
function moduleFilePath(id: string): string | null {
  if (!isSafeModuleId(id)) return null;
  const candidate = resolve(MODULES_DIR, `${id}.json`);
  const fromModules = relative(MODULES_DIR, candidate);
  if (!fromModules || fromModules === ".." || fromModules.startsWith(`..${sep}`) || isAbsolute(fromModules)) return null;
  return candidate;
}

function lstatOrAbsent(path: string) {
  try { return lstatSync(path); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function ensureDir() {
  const existing = lstatOrAbsent(MODULES_DIR);
  if (!existing) mkdirSync(MODULES_DIR, { recursive: true });
  const stat = lstatOrAbsent(MODULES_DIR);
  if (!stat) throw new Error("module storage is unavailable");
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("module storage is unavailable");
}

function regularModuleFile(path: string): boolean {
  const stat = lstatOrAbsent(path);
  return stat !== null && stat.isFile() && !stat.isSymbolicLink();
}

/** 列出所有已保存的模组 */
export function listSavedModules(): { id: string; name: string; description: string; difficulty: string }[] {
  ensureDir();
  return readdirSync(MODULES_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({ id: file.slice(0, -".json".length), path: moduleFilePath(file.slice(0, -".json".length)) }))
    .filter((entry): entry is { id: string; path: string } => entry.path !== null && regularModuleFile(entry.path))
    .map(({ id, path }) => {
      try {
        const parsed = parseMythosModule(JSON.parse(readFileSync(path, "utf-8")));
        if (!parsed.ok || parsed.module.id !== id) return null;
        return { id: parsed.module.id, name: parsed.module.name, description: parsed.module.description, difficulty: parsed.module.difficulty };
      } catch { return null; }
    })
    .filter(Boolean) as { id: string; name: string; description: string; difficulty: string }[];
}

/** 按 ID 加载模组 */
export function loadModuleFile(id: string): MythosModule | null {
  const fp = moduleFilePath(id);
  if (!fp) return null;
  ensureDir();
  if (!regularModuleFile(fp)) return null;
  try {
    const parsed = parseMythosModule(JSON.parse(readFileSync(fp, "utf-8")));
    return parsed.ok && parsed.module.id === id ? parsed.module : null;
  } catch {
    return null;
  }
}

// ============================================================
// 边界解析 — HTTP 传入的模组文档在落盘前必须过这一关
// ============================================================

const MODULE_DIFFICULTIES = ["easy", "medium", "hard", "nightmare"] as const;
const ACTIVATION_TYPES = ["manual", "location_enter", "item_found", "read_tome", "san_threshold"] as const;

type ModuleDifficulty = (typeof MODULE_DIFFICULTIES)[number];
type ActivationType = (typeof ACTIVATION_TYPES)[number];

type ModuleParseResult =
  | { ok: true; module: MythosModule }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析外部传入的模组文档。
 *
 * 只校验 MythosModule 的必填字段与两个枚举，其余可选字段（scenes/npcs/clues/
 * hooks/kpNotes 等创作数据）原样透传——编辑器需要无损往返，为每种嵌套结构编造
 * schema 既无依据也会阻碍作者扩展。
 *
 * 这一关拦的是真实故障：畸形文档被写进 data/modules，之后 loadModuleFile 直接
 * JSON.parse 并断言成 MythosModule，问题要到加载模组时才暴露。
 */
export function parseMythosModule(input: unknown): ModuleParseResult {
  if (!isRecord(input)) return { ok: false, error: "模组文档必须是一个 JSON 对象" };

  // id/name/version 是标识与文件名来源，不允许空串；description 允许空（新建骨架即为空）。
  for (const key of ["id", "name", "version"] as const) {
    const value = input[key];
    if (typeof value !== "string" || value.trim() === "") {
      return { ok: false, error: `字段 ${key} 必须是非空字符串` };
    }
  }
  if (!isSafeModuleId(input.id)) return { ok: false, error: "module id is invalid" };
  if (typeof input.description !== "string") {
    return { ok: false, error: "字段 description 必须是字符串" };
  }

  const difficulty = input.difficulty;
  if (typeof difficulty !== "string" || !(MODULE_DIFFICULTIES as readonly string[]).includes(difficulty)) {
    return { ok: false, error: `字段 difficulty 必须是 ${MODULE_DIFFICULTIES.join(" / ")} 之一` };
  }

  const activation = input.activation;
  if (!isRecord(activation)) return { ok: false, error: "字段 activation 必须是对象" };
  const activationType = activation.type;
  if (typeof activationType !== "string" || !(ACTIVATION_TYPES as readonly string[]).includes(activationType)) {
    return { ok: false, error: `activation.type 必须是 ${ACTIVATION_TYPES.join(" / ")} 之一` };
  }
  if (typeof activation.condition !== "string") {
    return { ok: false, error: "activation.condition 必须是字符串" };
  }

  return {
    ok: true,
    module: {
      ...input,
      id: input.id as string,
      name: input.name as string,
      version: input.version as string,
      description: input.description,
      difficulty: difficulty as ModuleDifficulty,
      activation: {
        ...activation,
        type: activationType as ActivationType,
        condition: activation.condition,
      },
    } as MythosModule,
  };
}

/** 保存模组（新建或更新） */
export function saveModuleFile(module: MythosModule): void {
  const fp = moduleFilePath(module.id);
  if (!fp) throw new Error("module id is invalid");
  ensureDir();
  const existing = lstatOrAbsent(fp);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("module storage target is unavailable");
  writeFileSync(fp, JSON.stringify(module, null, 2), "utf-8");
}

/** 删除模组 */
export function deleteModuleFile(id: string): void {
  const fp = moduleFilePath(id);
  if (!fp) throw new Error("module id is invalid");
  if (regularModuleFile(fp)) unlinkSync(fp);
}
