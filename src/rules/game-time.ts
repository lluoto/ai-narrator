// ============================================================
// 游戏内时间系统 — 昼夜循环 + 回合推进
// ============================================================

export type TimePeriod =
  | "dawn" | "morning" | "noon" | "afternoon"
  | "dusk" | "evening" | "night" | "late_night";

export interface GameTime {
  day: number;        // 第几天
  period: TimePeriod; // 当前时段
  /** 当前时段内已过回合数 */
  ticks: number;
}

const PERIOD_LABELS: Record<TimePeriod, string> = {
  dawn: "黎明",
  morning: "上午",
  noon: "正午",
  afternoon: "下午",
  dusk: "黄昏",
  evening: "傍晚",
  night: "夜晚",
  late_night: "深夜",
};

const PERIOD_ORDER: TimePeriod[] = [
  "dawn", "morning", "noon", "afternoon",
  "dusk", "evening", "night", "late_night",
];

/**
 * 同一份时段事实既供行动效果判定，也供过夜休息判定。
 *
 * 黄昏起算夜间；不要让各个调用方各自维护一份 "night" 字符串数组。
 */
export const NIGHT_PERIODS: readonly TimePeriod[] = [
  "dusk", "evening", "night", "late_night",
];

export function isNightPeriod(period: TimePeriod): boolean {
  return NIGHT_PERIODS.includes(period);
}

/** 每时段最多回合数，超过则推进下一时段 */
const TICKS_PER_PERIOD = 3;

export function createGameTime(): GameTime {
  return { day: 1, period: "morning", ticks: 0 };
}

export function advanceTime(time: GameTime, ticks = 1): GameTime {
  let { day, period, ticks: t } = time;
  t += ticks;
  while (t >= TICKS_PER_PERIOD) {
    t -= TICKS_PER_PERIOD;
    const idx = PERIOD_ORDER.indexOf(period);
    if (idx < PERIOD_ORDER.length - 1) {
      period = PERIOD_ORDER[idx + 1];
    } else {
      period = PERIOD_ORDER[0];
      day++;
    }
  }
  return { day, period, ticks: t };
}

export function formatGameTime(time: GameTime): string {
  const periodLabel = PERIOD_LABELS[time.period] ?? time.period;
  const daySuffix = time.day === 1 ? "第一天" : `第${time.day}天`;
  return `${daySuffix} · ${periodLabel}`;
}

/** 根据时段返回环境描述修饰语 */
export function periodAtmosphere(period: TimePeriod): string {
  switch (period) {
    case "dawn": return "晨雾弥漫，天色渐亮。微弱的阳光透过云层洒下。";
    case "morning": return "阳光明媚，新的一天开始了。";
    case "noon": return "正午时分，烈日当空。";
    case "afternoon": return "午后时光，光线渐渐西斜。";
    case "dusk": return "暮色四合，天边残留着一抹暗红。";
    case "evening": return "夜幕降临，街灯陆续亮起。";
    case "night": return "夜色已深，只有月光和远处偶尔传来的狗吠打破寂静。";
    case "late_night": return "万籁俱寂。凌晨的空气冰冷而沉重，仿佛有什么东西在黑暗中蛰伏。";
  }
}
