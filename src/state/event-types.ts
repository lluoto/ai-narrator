// 游戏事件类型 — 事件日志记录

export interface GameEvent {
  round: number;
  timestamp: number;
  event_type: "combat" | "move" | "dialogue" | "discovery" | "item_use" | "scene_change" | "system";
  actor?: string;   // entity_id
  target?: string;  // entity_id
  description: string;
  result?: Record<string, unknown>;  // 结构化判定结果
  /**
   * 产出这条事件的同一次确定性触发。可选以兼容既有普通事件；
   * todo-17 的经济时钟会把 PoliticoEconomyEngine 已盖好的值原样写入 SQLite。
   */
  causationId?: string;
}
