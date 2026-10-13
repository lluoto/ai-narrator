/**
 * Deterministic ordinary-session commands are the only prose inputs allowed to
 * bypass required model classification.  Keep recognition and execution on
 * this one full-input contract: a prefix alone is never sufficient.
 */

export type LocalSlashCommand = "roll" | "r" | "time" | "diff" | "difficulty" | "table" | "t" | "help" | "?";
export type OrdinaryLocalCommand =
  | { kind: "load_module"; moduleName?: string }
  | { kind: "slash"; command: LocalSlashCommand; args: string[] }
  | { kind: "recruit"; name: string; archetypeId: string }
  | { kind: "companion"; operation: "invite" | "farewell" | "control" | "auto"; name: string };

const SLASH_COMMANDS = new Set<LocalSlashCommand>([
  "roll", "r", "time", "diff", "difficulty", "table", "t", "help", "?",
]);
const TIME_PERIODS = new Set(["dawn", "morning", "noon", "afternoon", "dusk", "evening", "night", "late_night"]);
const DIFFICULTIES = new Set(["easy", "medium", "hard", "nightmare"]);
const DICE_EXPRESSION = /^(?:\d+)?d\d+(?:[+-]\d+)?$/i;
const MODULE_COMMAND = /^\s*(?:加载|装载|载入|导入|启用|使用)\s*(?:模组|剧本|模块)(?:\s+(.+?))?\s*$/;
const RECRUIT_COMMAND = /^创建队友\s+(\S+)\s+(\S+)\s*$/;
const COMPANION_COMMANDS: Array<{
  operation: Extract<OrdinaryLocalCommand, { kind: "companion" }>["operation"];
  pattern: RegExp;
}> = [
  { operation: "invite", pattern: /^邀请\s+(.+?)\s*$/ },
  { operation: "farewell", pattern: /^告别\s+(.+?)\s*$/ },
  { operation: "control", pattern: /^(?:控制|接管|手操)\s+(.+?)\s*$/ },
  { operation: "auto", pattern: /^(?:自动|放手|AI)\s+(.+?)\s*$/ },
];
// Slash arguments have no session-owned catalog, so retain a deliberately
// narrow atomic grammar there. Module and companion names are instead checked
// exactly against GameSession's current catalog/state; punctuation can be part
// of a legitimate title or name and must not be treated as a connector.
const NON_ATOMIC_SLASH_ARGUMENT = /[\r\n,，。;；!?！？&]|(?:然后|接着|随后|并且|再(?:去|来))|\b(?:and|then|after|followed\s+by)\b/i;

function singleArgument(value: string): string | null {
  const trimmed = value.trim();
  return trimmed && !/[\r\n]/.test(trimmed) ? trimmed : null;
}

function atomicSlashArgument(value: string): string | null {
  const trimmed = singleArgument(value);
  return trimmed && !NON_ATOMIC_SLASH_ARGUMENT.test(trimmed) ? trimmed : null;
}

function parseSlashCommand(input: string): OrdinaryLocalCommand | null {
  if (!input.startsWith("/") || /[\r\n]/.test(input)) return null;
  const raw = input.slice(1).trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/);
  const command = parts[0]!.toLowerCase() as LocalSlashCommand;
  const args = parts.slice(1);
  if (!SLASH_COMMANDS.has(command)) return null;
  if (args.some((arg) => !atomicSlashArgument(arg))) return null;
  if ((command === "help" || command === "?") && args.length > 0) return null;
  if ((command === "time" || command === "diff" || command === "difficulty") && args.length > 1) return null;
  if ((command === "table" || command === "t") && args.length > 2) return null;
  if ((command === "roll" || command === "r") && args.length > 0 && !DICE_EXPRESSION.test(args.join(""))) return null;
  if (command === "time" && args.length === 1 && !TIME_PERIODS.has(args[0]!.toLowerCase())) return null;
  if ((command === "diff" || command === "difficulty") && args.length === 1 && !DIFFICULTIES.has(args[0]!.toLowerCase())) return null;
  if ((command === "table" || command === "t") && args.length === 2 && !/^\d+$/.test(args[1]!)) return null;
  return { kind: "slash", command, args };
}

/** Returns a command only when the complete input has one local, unambiguous meaning. */
export function parseOrdinaryLocalCommand(input: string): OrdinaryLocalCommand | null {
  const slash = parseSlashCommand(input);
  if (slash) return slash;

  const moduleMatch = MODULE_COMMAND.exec(input);
  if (moduleMatch) {
    if (moduleMatch[1] === undefined) return { kind: "load_module" };
    const moduleName = singleArgument(moduleMatch[1]);
    if (moduleName) return { kind: "load_module", moduleName };
    return null;
  }

  const recruitMatch = RECRUIT_COMMAND.exec(input);
  if (recruitMatch) {
    const name = singleArgument(recruitMatch[1]!);
    const archetypeId = singleArgument(recruitMatch[2]!);
    if (name && archetypeId) return { kind: "recruit", name, archetypeId };
    return null;
  }

  for (const candidate of COMPANION_COMMANDS) {
    const match = candidate.pattern.exec(input);
    if (!match) continue;
    const name = singleArgument(match[1]!);
    return name ? { kind: "companion", operation: candidate.operation, name } : null;
  }
  return null;
}
