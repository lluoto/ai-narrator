/**
 * 自定义模组索引
 * ==============
 *
 * 从 PDF 提取的模组在此注册，供 GameSession 动态加载。
 *
 * 添加新模组：
 *   1. 运行 extract-module.ts 提取模组
 *   2. 在此文件导入并注册
 *
 * 用法：
 *   import { getModule } from "./custom-modules/index";
 *   const module = getModule("premiers_barn");
 */

import type { MythosModule } from "../mythos-module";
import type { RuntimeModuleData } from "../../module/types";
import { BARN_OF_PREMIER } from "../../module/barn-of-premier";

// ── 模组注册表 ──
// 所有已提取的社区模组在此注册
export type CustomModuleData = MythosModule | RuntimeModuleData;
export interface CustomModuleEntry {
  name: string;
  module: CustomModuleData;
}

const _moduleMap = new Map<string, CustomModuleEntry>();

function register(entries: Array<{ id: string; name: string; module: CustomModuleData }>) {
  for (const entry of entries) {
    _moduleMap.set(entry.id, entry);
  }
}

// 谷仓只有 ModuleData 一份维护数据；Arkham/InnsMouth 保留在 legacy 分支。
register([{ id: "premiers_barn", name: "普瑞米尔的谷仓", module: BARN_OF_PREMIER }]);

// ── 公开接口 ──

/** 按 ID 获取模组 */
export function getModule(id: string): CustomModuleEntry | undefined {
  return _moduleMap.get(id);
}
