/**
 * The reward candidate boundary is intentionally lexical and fail-closed. It
 * recognizes only the settlement values that RewardSettlement can execute;
 * it does not infer a reward from a stat-shaped table row.
 */

type RewardMetric = {
  pattern: RegExp;
  maximum: number;
  allowsDice: boolean;
  allowsBareFixed: boolean;
};

const REWARD_HEADING = /(?:\brewards?\b|\bsettlements?\b|奖励|结算)/iu;
const INLINE_REWARD_CONTEXT = /(?:\brewards?\b|\bsettlements?\b|\baward(?:ed|s)?\b|\bgain(?:ed|s)?\b|\brecover(?:ed|s|y)?\b|\brestore(?:d|s)?\b|奖励|结算|获得|恢复|回复|增加|提升)/iu;
const POSITIVE_SETTLEMENT_PREFIX = /^[\s:：=]*(?:\+\s*|(?:奖励|结算|获得|恢复|回复|增加|提升|award(?:ed|s)?|gain(?:ed|s)?|recover(?:ed|s|y)?|restore(?:d|s)?|settle(?:d|ment|s)?)\s*(?:\+\s*)?)/iu;

const REWARD_METRICS: readonly RewardMetric[] = [
  { pattern: /(?:\bsanity\b|\bsan\b|理智(?:值)?)/iu, maximum: 100, allowsDice: true, allowsBareFixed: false },
  { pattern: /(?:\bcthulhu\s+mythos\b|\bcm\b|克苏鲁神话(?:知识)?)/iu, maximum: 99, allowsDice: false, allowsBareFixed: true },
  { pattern: /(?:\bcredit\s+rating\b|\breputation\b|\bcr\b|信用评级|信誉|声望)/iu, maximum: 99, allowsDice: false, allowsBareFixed: true },
];

function normalizedSourceText(text: string): string {
  return text.normalize("NFKC").replace(/[\s\u00a0\u3000]+/gu, " ").trim();
}

function boundedPositive(text: string, maximum: number): boolean {
  const value = Number(text);
  return Number.isInteger(value) && value >= 1 && value <= maximum;
}

function settlementValue(remainder: string, allowBarePositive: boolean): { value: string; explicit: boolean } | undefined {
  const prefix = remainder.match(POSITIVE_SETTLEMENT_PREFIX);
  if (prefix) return { value: remainder.slice(prefix[0].length), explicit: true };
  if (!allowBarePositive) return undefined;
  return { value: remainder.replace(/^[\s:：=]*/u, ""), explicit: false };
}

function metricHasPositiveSettlement(text: string, metric: RewardMetric, allowBarePositive: boolean): boolean {
  const match = metric.pattern.exec(text);
  if (!match || match.index === undefined) return false;
  const remainder = text.slice(match.index + match[0].length);
  const settlement = settlementValue(remainder, allowBarePositive);
  if (!settlement) return false;
  const { value } = settlement;

  if (metric.allowsDice) {
    const dice = value.match(/^([1-9]\d{0,2})\s*[dD]\s*([1-9]\d{0,2})(?![\p{L}\p{N}_.%/]|\s*(?:[%/]))/u);
    if (dice && boundedPositive(dice[1]!, 100) && boundedPositive(dice[2]!, 100) && Number(dice[2]) >= 2) return true;
  }
  const fixed = value.match(/^([1-9]\d{0,2})(?![\p{L}\p{N}_.%/]|\s*(?:[dD%/]))/u);
  return !!fixed && (settlement.explicit || metric.allowsBareFixed) && boundedPositive(fixed[1]!, metric.maximum);
}

/**
 * Return true only for a source row that has an executable RewardSettlement
 * shape plus positive reward evidence. A reward/settlement heading supplies
 * context; elsewhere the row must carry its own reward or recovery wording.
 */
export function isEligibleRewardSourceRow(headingText: string, rowText: string): boolean {
  const heading = normalizedSourceText(headingText);
  const row = normalizedSourceText(rowText);
  const positiveContext = REWARD_HEADING.test(heading) || INLINE_REWARD_CONTEXT.test(row);
  return !!heading && !!row && positiveContext && REWARD_METRICS.some((metric) => metricHasPositiveSettlement(row, metric, positiveContext));
}
