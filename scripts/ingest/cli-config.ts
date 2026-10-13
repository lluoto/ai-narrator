import { join } from "path";

export const DEFAULT_INGEST_OUTPUT_DIR = "analysis/ingest";

type Environment = Readonly<Record<string, string | undefined>>;

export interface IngestRunConfig {
  pdfPath: string;
  moduleId: string;
  moduleTitle: string;
  outputDir: string;
  baseline: "barn" | undefined;
}

export interface E2ERunConfig {
  modulePath: string;
}

export type ConfigParseResult<T> =
  | { ok: true; config: T }
  | { ok: false; message: string };

interface ParsedArgs {
  options: Map<string, string>;
  positionals: string[];
}

function nonBlank(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

function parseArgs(args: string[], supportedOptions: readonly string[]): ConfigParseResult<ParsedArgs> {
  const options = new Map<string, string>();
  const positionals: string[] = [];
  const supported = new Set(supportedOptions);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    if (!supported.has(name)) return { ok: false, message: `未知选项：${name}` };
    const value = equals === -1 ? args[++index] : argument.slice(equals + 1);
    if (!nonBlank(value)) return { ok: false, message: `选项 ${name} 缺少值` };
    if (options.has(name)) return { ok: false, message: `选项 ${name} 不能重复指定` };
    options.set(name, value!);
  }
  return { ok: true, config: { options, positionals } };
}

function optionOrEnv(options: Map<string, string>, option: string, env: Environment, envName: string): string | undefined {
  return nonBlank(options.get(option)) ?? nonBlank(env[envName]);
}

function titleFromPdfPath(pdfPath: string): string | undefined {
  const fileName = pdfPath.split(/[\\/]/).at(-1) ?? "";
  const extensionIndex = fileName.lastIndexOf(".");
  return nonBlank(extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName);
}

export function parseIngestRunConfig(args: string[], env: Environment): ConfigParseResult<IngestRunConfig> {
  const parsed = parseArgs(args, ["--module-id", "--title", "--out", "--baseline"]);
  if (!parsed.ok) return parsed;
  if (parsed.config.positionals.length > 1) return { ok: false, message: "只接受一个 PDF 路径参数" };

  const pdfPath = nonBlank(parsed.config.positionals[0]) ?? nonBlank(env.INGEST_PDF);
  if (!pdfPath) return { ok: false, message: "用法：bun scripts/ingest/run.ts <模组 PDF 路径>（或设置 INGEST_PDF）" };

  const baselineValue = optionOrEnv(parsed.config.options, "--baseline", env, "INGEST_BASELINE");
  if (baselineValue && baselineValue !== "barn") return { ok: false, message: `不支持的 INGEST_BASELINE：${baselineValue}` };
  const baseline = baselineValue as "barn" | undefined;

  const moduleId = optionOrEnv(parsed.config.options, "--module-id", env, "INGEST_MODULE_ID")
    ?? (baseline === "barn" ? "barn-of-premier-ingested" : undefined);
  if (!moduleId) {
    return { ok: false, message: "无基准 PDF 必须通过 --module-id 或 INGEST_MODULE_ID 提供模块身份" };
  }

  const moduleTitle = optionOrEnv(parsed.config.options, "--title", env, "INGEST_MODULE_TITLE")
    ?? (baseline === "barn" ? "普瑞米尔的谷仓（摄取）" : titleFromPdfPath(pdfPath));
  if (!moduleTitle) return { ok: false, message: "无法从 PDF 路径得到标题；请通过 --title 或 INGEST_MODULE_TITLE 提供标题" };

  return {
    ok: true,
    config: {
      pdfPath,
      moduleId,
      moduleTitle,
      outputDir: optionOrEnv(parsed.config.options, "--out", env, "INGEST_OUT") ?? DEFAULT_INGEST_OUTPUT_DIR,
      baseline,
    },
  };
}

export function parseE2ERunConfig(args: string[], env: Environment): ConfigParseResult<E2ERunConfig> {
  const parsed = parseArgs(args, ["--module", "--out"]);
  if (!parsed.ok) return parsed;
  if (parsed.config.positionals.length > 1) return { ok: false, message: "只接受一个 module.json 路径参数" };

  const explicitModulePath = nonBlank(parsed.config.positionals[0])
    ?? optionOrEnv(parsed.config.options, "--module", env, "INGEST_MODULE");
  const outputDir = optionOrEnv(parsed.config.options, "--out", env, "INGEST_OUT");
  if (explicitModulePath && outputDir) {
    return { ok: false, message: "module.json 路径与输出目录不能同时指定" };
  }
  return { ok: true, config: { modulePath: explicitModulePath ?? join(outputDir ?? DEFAULT_INGEST_OUTPUT_DIR, "module.json") } };
}
