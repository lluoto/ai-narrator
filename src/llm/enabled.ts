/**
 * 这一局到底能不能打 LLM。
 *
 * 「该不该打网络」的**唯一**判据，别在别处重写一份 —— play-module.ts 记着上次
 * 抄第二份的代价（`llmOnce` 只看 key、runModuleInner 那份还看 `LLM_DISABLED`/
 * `LLM_MODE`，于是有 key 时离线开关拦不住打网络）。
 *
 * 抽到 `llm/` 这个低层而不是留在 play-module.ts：player-agent.ts 的 decideViaLLM
 * 也要用它（判断该走接缝还是降级）。放回 play-module 会让
 * `play-module → player-agent → play-module` 成环，preflight 的 import 判据会拦。
 * 这里只依赖 process.env，无下层依赖，两处 import 都安全。
 */
export function isUsableLlmApiKey(apiKey: string | null | undefined): apiKey is string {
  const normalized = apiKey?.trim();
  return !!normalized
    && !normalized.startsWith("sk-placeholder")
    && normalized !== "sk-your-key-here"
    && !normalized.startsWith("${");
}

export function llmEnabled(): boolean {
  if (llmDisabledByOverride()) return false;
  const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY;
  return isUsableLlmApiKey(apiKey);
}

/** Explicit offline switches apply even to an otherwise valid session-owned config. */
export function llmDisabledByOverride(): boolean {
  return process.env.LLM_DISABLED === "true" || process.env.LLM_MODE === "template";
}
