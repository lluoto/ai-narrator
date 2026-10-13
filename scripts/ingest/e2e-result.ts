import { neutralSupport } from "../../src/ingest/assemble-module";
import type { ModuleSupport } from "../../src/module/types";
import { MODULE_ENDING_SUPPORT } from "../../src/play/module-departure";

export type E2ERunStop = "returned" | "engine-crash" | "action-limit" | "timeout";

export interface TerminalEndingEvidence {
  id: string;
  label: string;
}

export interface E2ERunEvidence {
  stop: E2ERunStop;
  moved: boolean;
  /** The structured `ending` event emitted by runModule, never inferred from narration. */
  terminalEnding: TerminalEndingEvidence | null;
}

export type E2ERunKind =
  | "terminal-completion"
  | "engine-crash"
  | "action-limit"
  | "timeout"
  | "movement-smoke"
  | "returned-without-ending";

export interface E2ERunResult {
  kind: E2ERunKind;
  completed: boolean;
  exitCode: 0 | 1;
}

/**
 * Select support by the exact ModuleData id. Ingested ids use their own id space,
 * so an unregistered artifact must remain neutral rather than borrow another
 * module's ending predicates.
 */
export function selectE2ESupport(moduleId: string): {
  support: ModuleSupport;
  source: "registered" | "neutral";
} {
  const support = MODULE_ENDING_SUPPORT[moduleId];
  return support
    ? { support, source: "registered" }
    : { support: neutralSupport(), source: "neutral" };
}

/**
 * Classify a finished runner attempt without inspecting narration. A completed
 * playthrough requires both normal return and the engine's structured ending
 * event; moving through scenes is useful smoke evidence but is never completion.
 */
export function classifyE2ERun(evidence: E2ERunEvidence): E2ERunResult {
  switch (evidence.stop) {
    case "engine-crash":
      return { kind: "engine-crash", completed: false, exitCode: 1 };
    case "action-limit":
      return { kind: "action-limit", completed: false, exitCode: 1 };
    case "timeout":
      return { kind: "timeout", completed: false, exitCode: 1 };
    case "returned":
      if (evidence.terminalEnding) {
        return { kind: "terminal-completion", completed: true, exitCode: 0 };
      }
      return evidence.moved
        ? { kind: "movement-smoke", completed: false, exitCode: 1 }
        : { kind: "returned-without-ending", completed: false, exitCode: 1 };
  }
}
