export interface OrdinaryCharacterPatchRequest {
  patch: Record<string, unknown>;
  expectedGeneration: number;
}

export function ordinaryCharacterEditorVisible(value?: Record<string, unknown>): boolean;
export function ordinaryCharacterPatchRequest(value?: Record<string, unknown>): OrdinaryCharacterPatchRequest | null;
export function submitOrdinaryCharacterPatch<T>(
  view: Record<string, unknown>,
  execute: (request: OrdinaryCharacterPatchRequest) => Promise<T>,
): Promise<{ kind: "not-submitted" } | { kind: "submitted"; request: OrdinaryCharacterPatchRequest; result: T }>;
export function ordinaryCharacterPatchOutcome(result: unknown): Record<string, unknown>;
