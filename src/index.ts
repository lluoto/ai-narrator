// AI Narrator — 多 Agent 游戏主循环（v2：含世界状态管理器）
// 运行: bun run src/index.ts
//
// 流程:
//   玩家输入 → 意图解析 → 律书判定 → 状态写入 → KP叙事 → NPC反应 → 快照 → 等待下轮
//                                                          ↑
//                                             LLM 上下文来自 SQLite 快照
//                                             （非原始对话历史——token 恒定）

import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { createInterface } from "readline";

import { loadConfig } from "./config";
import { LLMClient } from "./llm/client";
import { parseIntent, setIntentLLM } from "./llm/intent";
import { generateNarrative, setNarratorLLM } from "./llm/narrator";
import { RuleEngine } from "./engine/rule-engine";
import { RulesEngine, toCombatResult, type RulesetId } from "./rules/rules-engine";
import { CoCEngine, SanityEngine, SUCCESS_LEVEL_LABELS, sanOutcomeLabel } from "./rules/coc-engine";

import { KPAgent } from "./agent/kp-agent";
import { AgentRegistry, fanoutAgentRegistryMessageForHost } from "./agent/agent-registry";
import { WorldStateManager } from "./state/world-state-manager";
import type { WorldEntity } from "./types";
import { NPCCombatEngine, NPC_ARMED_SKILL, NPC_UNARMED_SKILL } from "./combat/npc-combat";
import { PlayerSession, type VisibilityRule } from "./session/player-session";
import { InvestigationEngine } from "./investigation/investigation-engine";
import { WorldModelLoader, DEFAULT_V18_PATH, DEFAULT_CTHULHU_PATH } from "./world/world-model-loader";
import { WorldModelIntegrator } from "./world/world-model-integrator";
import { CharacterFactory, getArchetype, type GeneratedCharacter, type CharacterArchetype } from "./character/character-factory";
import { PRESTIGE_CLASSES } from "./character/prestige-classes";
import { QIANKUN_SUBCLASSES, getAllQiankunLegendaryTemplates } from "./character/qiankun-subclasses";
import { createCoCCharacter, getCoCArchetypes, type CoCGeneratedCharacter, getSkillValue, getBaseSkillValue } from "./character/coc-character";
import { COC_WEAPONS_FULL } from "./rules/coc-equipment";
import { NPCStore } from "./db/index";
import { BARN_OF_PREMIER, NPC_STATS } from "./module/barn-of-premier";
import { populateWorldFromModule } from "./world/module-loader";

CharacterFactory.registerExtra(PRESTIGE_CLASSES);
CharacterFactory.registerExtra(QIANKUN_SUBCLASSES);
CharacterFactory.registerLegendaryTemplates(getAllQiankunLegendaryTemplates());

import type { NPCPersonality, AgentMessage, TurnRecord, KPDirective } from "./agent/types";

import { log } from "./log";

// ============================================================
// 初始化
// ============================================================

const config = loadConfig();
const llm = new LLMClient(config);
setIntentLLM(llm);
setNarratorLLM(llm);

const ruleEngine = new RuleEngine(); // D&D 保留兼容
const rules = new RulesEngine();      // 统一路由
const world = new WorldStateManager();
const npcCombat = new NPCCombatEngine();
// 权威场景来源闭包过 world——PlayerSession 自己不再存一份会漂移的
// 场景拷贝（开发·多人可见性 N6，todo-24），见该类构造函数注释。
const session = new PlayerSession((characterId) => world.getCurrentState().entities[characterId]?.position);
// 挂 world：线索发现落真相源，不是引擎自己的进程内 Map——
// 见 InvestigationEngine 构造函数与 markDiscovered 的注释。
const investigation = new InvestigationEngine("./src/rules/investigation.yaml", world);
const sanity = new SanityEngine(55);
// CoC 角色（由 /horror-create 生成，替代 D&D activeCharacter）
let cocCharacter: CoCGeneratedCharacter | null = null;
// CoC 弹药追踪: weaponKey → { current, max, ammoType }
const cocAmmo: Map<string, { current: number; max: number; ammoType: string }> = new Map();
const worldModel = new WorldModelLoader();
worldModel.load(DEFAULT_V18_PATH);
const wmIntegrator = new WorldModelIntegrator(worldModel);
// 克苏鲁神话世界模型（独立第二 loader，懒加载，失败静默降级为不可用）
const cthulhuLoader = new WorldModelLoader();

/**
 * 构建克苏鲁神话世界模型上下文（追加段）。
 * 独立懒加载 cthulhu_world_model.jsonl（145 条 / 小文件）；失败静默返回空串。
 */
function buildCthulhuContext(): string {
  try {
    if (!cthulhuLoader.isLoaded()) {
      cthulhuLoader.load(DEFAULT_CTHULHU_PATH);
    }
    if (!cthulhuLoader.isLoaded()) return "";

    const lines: string[] = [];
    lines.push("[克苏鲁神话上下文]");

    const deities = cthulhuLoader.getByType("deity");
    if (deities.length > 0) {
      lines.push("神话存在:");
      for (const d of deities.slice(0, 6)) {
        const name = d.name || "未知";
        const domains = (d as any).domains ? `(领域: ${(d as any).domains.join("、")})` : "";
        const mechanic = d.mechanic ? ` ${d.mechanic.slice(0, 80)}` : "";
        lines.push(`  - ${name}${domains}${mechanic}`);
      }
    }

    const mechanics = [
      ...cthulhuLoader.getByType("power_system"),
      ...cthulhuLoader.getByType("game_mechanic"),
      ...cthulhuLoader.getByType("crafting"),
      ...cthulhuLoader.getByType("cosmology"),
    ].slice(0, 8);
    if (mechanics.length > 0) {
      lines.push("神秘机制:");
      for (const m of mechanics) {
        const name = m.name || "未知";
        const mechanic = m.mechanic ? m.mechanic.slice(0, 90) : (m.description || "").slice(0, 90);
        lines.push(`  - ${name}: ${mechanic}`);
      }
    }

    const causals = cthulhuLoader.getByType("causal").slice(0, 3);
    if (causals.length > 0) {
      lines.push("可推进的怪异事件方向:");
      for (const c of causals) {
        const name = c.name || "未知";
        const mechanic = c.mechanic ? c.mechanic.slice(0, 90) : "";
        lines.push(`  - ${name}: ${mechanic}`);
      }
    }

    return lines.length > 1 ? lines.join("\n") : "";
  } catch {
    return "";
  }
}

// 当前激活的规则集
let activeRuleset = "dnd5e";
// 当前激活的小说上下文（用于世界模型路由）
let activeNovel = "";

// 默认玩家——初始场景不再由这里指定：场景是权威来源（world 里的实体
// position）说了算，见 PlayerSession 构造函数的 sceneOf 注释。
session.join("p1", "调查员", "player");

// NPC 持久化数据库
const npcStore = new NPCStore();

// 加载 NPC 人格卡 → 注册到热插拔容器
const npcYaml = readFileSync("./src/agent/npcs.yaml", "utf-8");
const npcData: any = parseYaml(npcYaml);
const personalities: NPCPersonality[] = npcData.npcs;
const registry = new AgentRegistry(llm, npcStore);
registry.registerAll(personalities);

// 实体死亡 → 自动注销 Agent
registry.onEvent((name, event) => {
  if (event === "unregister") {
    console.log(`  🔌 Agent 已注销: ${name}`);
  }
});

// KP 指令（从模组数据生成）
// ⚠ 这一行原先算出 NPC 名单**然后扔掉**（tsc 的 noUnusedLocals 报的）。
//   而 `scene_elements` 的类型注释写着「场景中的关键元素（**NPC**、物品、线索等）」，
//   代码却只塞了场景名 —— 也就是说 **KP 从头到尾不知道模组里有谁**。
//   算好的东西就在上一行，没进去。
const moduleNpcList = BARN_OF_PREMIER.npcs.map(n => `${n.name}（${n.role}）`);
const kpDirective: KPDirective = {
  scene_description: BARN_OF_PREMIER.scenes[0]?.description ?? "",
  scene_elements: [
    ...BARN_OF_PREMIER.scenes.slice(0, 5).map(s => s.name),
    ...moduleNpcList,
  ],
  plot_nodes: [],
  current_phase: "arrival",
  style: "lovecraft",
};

const kp = new KPAgent(kpDirective, llm);

// ============================================================
// 初始化世界状态（从模组数据加载）
// ============================================================

populateWorldFromModule(world, BARN_OF_PREMIER, NPC_STATS);

// 默认场景（模组首个场景）
const INITIAL_SCENE = BARN_OF_PREMIER.scenes[0]?.id ?? "start";

// ============================================================
// 辅助
// ============================================================

function addMessage(
  speaker: string, content: string,
  type: AgentMessage["type"] = "dialogue",
  visibility: VisibilityRule = "public",
  discoverer?: string
) {
  const msg: AgentMessage = { speaker, content, type };
  fanoutAgentRegistryMessageForHost(registry, session, msg, visibility, discoverer);
}

let round = 0;

const playerCharacter = {
  name: "调查员", id: "player",
  proficiency: 2,
  abilities: { strength: 12, dexterity: 14, constitution: 12, intelligence: 15, wisdom: 14, charisma: 10 },
  hasSneakAttack: false,
};

// 角色卡（可被 /create 替换）
let activeCharacter: GeneratedCharacter | null = null;

/**
 * GeneratedCharacter.archetype 存的是职业 id 字符串，不是目录对象。
 * 此前多处直接写 activeArchetypeLabel() / .featChoices / .levelFeatures，
 * 运行时全是 undefined —— 等级特性与专长提示因此从未触发过。
 */
function activeArchetype(): CharacterArchetype | undefined {
  return activeCharacter ? getArchetype(activeCharacter.archetype) : undefined;
}

/** 职业显示名；目录里查不到时退回 id。 */
function activeArchetypeLabel(): string {
  return activeArchetype()?.label ?? activeCharacter?.archetype ?? "未知";
}

function divider(char = "─", len = 60) {
  return char.repeat(len);
}

/** CoC 技能 key → 中文名映射 */
const KEY_TO_LABEL: Record<string, string> = {
  fighting: "格斗(肉搏)", firearms_pistol: "射击(手枪)", firearms_rifle: "射击(步枪/霰弹枪)",
  spot_hidden: "侦查", listen: "聆听", stealth: "潜行", library_use: "图书馆使用",
  occult: "神秘学", psychology: "心理学", medicine: "医学", dodge: "闪避",
  persuade: "说服", fast_talk: "话术", intimidate: "恐吓",
  credit_rating: "信用评级", history: "历史", archaeology: "考古学",
};

/** 从 intent.weapon 匹配 COC_WEAPONS_FULL 的 key（仅含弹药的武器） */
function findCoCWeaponKey(weapon: string): string | null {
  if (COC_WEAPONS_FULL[weapon]?.capacity) return weapon;
  for (const key of Object.keys(COC_WEAPONS_FULL)) {
    const def = COC_WEAPONS_FULL[key];
    if (!def.capacity) continue;
    if (key.includes(weapon) || weapon.includes(key)) return key;
  }
  return null;
}

/** SAN 检定辅助 — 触发 sanityCheck 并输出到控制台和消息 */
function checkSanity(reason: string, sanCost: string): string | null {
  if (activeRuleset !== "cosmic-horror") return null;
  const result = sanity.sanityCheck(sanCost);
  if (result.sanLoss <= 0) return null;

  let msg = `[SAN 检定] ${reason}: ${sanOutcomeLabel(result.passed)}，SAN -${result.sanLoss} (当前 ${sanity.state.currentSAN}/${sanity.state.maxSAN})`;
  if (result.boutOfMadness) {
    msg += `\n  💥 临时疯狂！${result.boutOfMadness}`;
  }
  if (result.indefiniteInsanityTriggered) {
    msg += `\n  ⚠ 不定疯狂触发！等级: ${result.indefiniteLevel}`;
  }
  if (result.newPhobia) {
    msg += `\n  😱 获得恐惧症: ${result.newPhobia}`;
  }
  console.log(`  ${msg}`);
  addMessage("系统", msg, "system");
  return msg;
}

/** 获取当前世界状态上下文（注入 LLM） */
function getPlayerHistory(): AgentMessage[] {
  return session.getActiveHistory();
}

// 原先这里有个 `getActiveScene()`，返回 `kp.getDirective().current_phase` —— 没人调用。
// 名字也名不副实：它返回的是剧情阶段，不是场景。留着只会误导下一个人。

function getPlayerAttributes(): { name: string; id: string; proficiency: number; abilities: Record<string, number>; hasSneakAttack: boolean; cocAttrs?: Record<string, number>; getSkill?: (key: string) => number } {
  if (activeRuleset === "cosmic-horror" && cocCharacter) {
    // 捕获成局部常量再交给闭包：cocCharacter 是模块级可变量，上面的判空只在
    // 这一刻成立。getSkill 是留给调用方以后调的，那时它可能已经被换角色或置空，
    // 闭包直接读外层变量就会在运行时炸。捕获之后，返回的这份属性表自洽。
    const coc = cocCharacter;
    return {
      name: coc.name, id: "player",
      proficiency: 2,
      abilities: { strength: coc.attributes.strength, dexterity: coc.attributes.dexterity, constitution: coc.attributes.constitution, intelligence: coc.attributes.intelligence, wisdom: coc.attributes.power, charisma: coc.attributes.appearance },
      hasSneakAttack: false,
      cocAttrs: coc.attributes,
      getSkill: (key: string) => {
        if (key === "dodge") return Math.floor((coc.attributes.dexterity ?? 50) / 2);
        if (key === "fighting") return getSkillValue(coc.occupationSkills, coc.skillValues, "fighting") || 25;
        if (key.startsWith("firearms")) return getSkillValue(coc.occupationSkills, coc.skillValues, key) || 20;
        return getSkillValue(coc.occupationSkills, coc.skillValues, key) || 0;
      },
    };
  }
  if (activeCharacter) {
    return {
      name: activeCharacter.name, id: "player",
      proficiency: 2,
      abilities: activeCharacter.attributes,
      hasSneakAttack: activeCharacter.archetype === "scout",
    };
  }
  return playerCharacter;
}

function getActiveSceneKeywords(): string[] {
  const directive = kp.getDirective();
  const words = [directive.current_phase, ...directive.scene_elements];
  const state = world.getCurrentState();
  for (const e of Object.values(state.entities)) {
    if (e.hp > 0) words.push(e.name);
  }
  return words;
}

function buildSceneContext() {
  const state = world.getCurrentState();
  const directive = kp.getDirective();
  return {
    sceneId: state.scene,
    sceneName: directive.scene_description.slice(0, 40),
    keywords: getActiveSceneKeywords(),
    presentNPCs: Object.values(state.entities)
      .filter(e => e.type === "npc" && e.hp > 0)
      .map(e => e.name),
    discoveredClues: investigation.getDiscoveredBy(session.getActive()?.name ?? "p1"),
    round,
    activeNovel: activeNovel || undefined,
    ruleset: activeRuleset,
  };
}

// ============================================================
// 玩家输入处理
// ============================================================

async function handlePlayerInput(input: string) {
  round++;
  const turnMessages: AgentMessage[] = [];
  // 原先这里取了 playerName / playerId 两个值，一处都没用到。
  // 下面的 logEvent 只记输入文本，谁做的这件事其实没被记下来 —— 但那是
  // 事件模型的决定，不该顺手在这里替它改。先把死变量去掉。

  // 世界状态写入当前回合
  world.logEvent({
    round, timestamp: Date.now(),
    event_type: "system",
    description: `玩家输入: ${input}`,
  });

  // Step 1: 意图解析
  const intent = await parseIntent(input);
  if (intent.action === "attack" && intent.target) {
    await handleCombat(intent, turnMessages);
  } else if (intent.action === "move") {
    await handleMovement(intent, turnMessages);
  } else if (intent.action === "skill_check") {
    await handleInvestigation(input, turnMessages);
  } else {
    await handleFreeNarration(input, turnMessages);
  }

  // ── NPC 战斗阶段 ──
  // 所有在场的敌对 NPC 各自行动一次
  const state = world.getCurrentState();
  const playerEntity = state.entities["player"];
  if (playerEntity) {
    const hostileNPCs = Object.values(state.entities).filter(
      (e) => npcCombat.shouldEngage(e, playerEntity)
    );
    for (const npc of hostileNPCs) {
      const npcIntent = npcCombat.decide(npc, world, activeRuleset);
      if (!npcIntent) {
        // NPC 逃跑或无法行动
        if (npc.hp / npc.maxHp <= 0.3) {
          const fleeMsg = `${npc.name} 转身逃跑！`;
          console.log(`  🏃 ${fleeMsg}`);
          addMessage("系统", fleeMsg, "system");
          turnMessages.push({ speaker: "系统", content: fleeMsg, type: "system" });
        }
        continue;
      }
      await resolveNPCAction(npc, npcIntent, turnMessages);
    }
  }

  // 回合收尾：世界模型集成注入
  if (worldModel.isLoaded() && round % 4 === 0) {
    const ctx = buildSceneContext();

    // CoC 规则线索
    if (activeRuleset === "cosmic-horror") {
      const cocHints = wmIntegrator.getRuleHints("cosmic-horror", ctx);
      if (cocHints.length > 0) {
        const hintText = "[CoC 神话线索]\n" + cocHints.map(h => `  - ${h}`).join("\n");
        const narration = await kp.narrateOutcome("CoC 神话线索", hintText, getPlayerHistory());
        console.log(`  🌐 ${narration.slice(0, 80)}...`);
        addMessage("KP", narration, "narration", "public");
        turnMessages.push({ speaker: "KP", content: narration, type: "narration" });
      }
    }

    // D&D / 通用世界模型
    let injection = wmIntegrator.buildKPContext(ctx);
    // 克苏鲁神话上下文（独立 loader，失败静默跳过）
    const cthulhuText = buildCthulhuContext();
    if (cthulhuText) {
      injection = injection ? `${injection}\n\n${cthulhuText}` : cthulhuText;
    }
    if (injection.length > 30) {
      const narration = await kp.narrateOutcome(
        "世界模型上下文",
        injection,
        getPlayerHistory()
      );
      console.log(`  🌐 ${narration.slice(0, 80)}...`);
      addMessage("KP", narration, "narration", "public");
      turnMessages.push({ speaker: "KP", content: narration, type: "narration" });
    }
  }

  // 回合收尾：效果 tick + 快照
  const expired = world.tickEffects();
  if (expired.length > 0) {
    for (const e of expired) {
      const msg = `[效果过期] ${e.description}`;
      addMessage("系统", msg, "system");
      turnMessages.push({ speaker: "系统", content: msg, type: "system" });
    }
  }

  const snapshotCtx = world.createSnapshot(round);

  const turn: TurnRecord = {
    round, timestamp: Date.now(),
    player_input: input,
    messages: turnMessages,
    world_snapshot: world.getCurrentState(),
  };
  kp.recordTurn(turn);

  // 调试：显示快照 token 估算
  const estTokens = Math.ceil(snapshotCtx.length / 2.5);
  console.log(`  🔖 快照已保存 (${snapshotCtx.length} 字符 ≈ ${estTokens} tokens)`);
}

// ============================================================
// 战斗处理
// ============================================================

async function handleCombat(
  intent: any, turnMessages: AgentMessage[]
) {
  const target = world.getEntityByName(intent.target);
  if (!target) {
    const msg = `没有找到目标: ${intent.target}`;
    console.log(`  ⚠ ${msg}`);
    addMessage("系统", msg, "system");
    turnMessages.push({ speaker: "系统", content: msg, type: "system" });
    return;
  }

  const attacker = getPlayerAttributes();
  const weapon = intent.weapon || "shortsword";
  const hasAdvantage = intent.method === "stealth";
  const hasDisadvantage = false;

  // CoC: 从角色卡获取战斗技能
  let cocSkill = 0;
  let cocDodge = 0;
  let damageDice: string | undefined;
  if (activeRuleset === "cosmic-horror" && attacker.getSkill) {
    const meleeWeapons = ["匕首", "小刀", "棍棒", "短剑", "手斧", "刀", "剑", "拳", "爪", "棒", "格斗"];
    const pistolWeapons = ["手枪", "左轮", ".38", ".45"];
    const rifleWeapons = ["步枪", "猎枪", "霰弹枪", "冲锋枪", ".22", ".30"];
    const isMelee = meleeWeapons.some(w => weapon.includes(w));
    const isPistol = pistolWeapons.some(w => weapon.includes(w));
    const isRifle = rifleWeapons.some(w => weapon.includes(w));

    if (isMelee) {
      cocSkill = attacker.getSkill("fighting");
      damageDice = "1d6+db";
    } else if (isPistol) {
      cocSkill = attacker.getSkill("firearms_pistol");
      damageDice = "1d10";
    } else if (isRifle) {
      cocSkill = attacker.getSkill("firearms_rifle");
      damageDice = "2d6+4";
    } else {
      cocSkill = attacker.getSkill("fighting");
      damageDice = "1d4+db";
    }
    cocDodge = attacker.getSkill("dodge");

    // 弹药追踪（火器消耗弹药）
    if (isPistol || isRifle) {
      const wk = findCoCWeaponKey(weapon);
      if (wk) {
        const def = COC_WEAPONS_FULL[wk];
        if (!cocAmmo.has(wk)) {
          cocAmmo.set(wk, { current: def.capacity!, max: def.capacity!, ammoType: def.ammoType! });
        }
        const ammo = cocAmmo.get(wk)!;
        if (ammo.current <= 0) {
          console.log(`  ⚠ ${wk} 弹药用尽！使用 /reload 装弹`);
        } else {
          ammo.current--;
          console.log(`  📦 ${wk} 弹药: ${ammo.current}/${ammo.max}`);
        }
      }
    }
  }

  // 律书判定
  const result = rules.adjudicateAttack(
    intent, attacker,
    { id: target.id, name: target.name, hp: target.hp, ac: target.ac, type: target.type, maxHp: target.maxHp, status: target.status, position: target.position },
    activeRuleset as RulesetId,
    hasAdvantage, hasDisadvantage, weapon,
    cocSkill || undefined, cocDodge || undefined, damageDice,
    // penaltyDiceOverride / isFightBack / fightBackDamageDice 这三个不指定。
    // 原先这里是五个 undefined —— 另外两个是那对从不生效的圣杯位阶参数。
    undefined, undefined, undefined,
    cocCharacter?.damageBonus
  );

  console.log(`  🎲 [${activeRuleset}] ${result.details} | ${result.hit ? `命中! ${result.damage}伤害 → ${result.result}` : "未命中"}`);

  // 世界状态更新：伤害应用
  if (result.hit) {
    const { killed } = world.applyDamage(target.id, result.damage);
    world.logCombatEvent(round, playerCharacter.id, target.id,
      `${attacker.name} 用 ${weapon} 攻击 ${target.name}，${result.hit ? `造成 ${result.damage} 点伤害` : "未命中"}`,
      toCombatResult(result)
    );
    if (killed) {
      world.logEvent({ round, timestamp: Date.now(), event_type: "system", description: `${target.name} 已死亡` });
      // 热插拔：实体死亡 → 自动注销 Agent
      if (registry.has(target.name)) {
        registry.unregister(target.name);
        console.log(`  🔌 ${target.name} Agent 已自动注销`);
      }
      // SAN 检定：击杀生物
      const isMonster = target.type === "monster";
      if (isMonster) {
        checkSanity(`击杀 ${target.name}`, "1/1d6");
      } else if (target.type === "npc") {
        checkSanity(`击杀人类 ${target.name}`, "0/1d3");
      }
    }
  }

  // 叙事生成
  const narrative = await generateNarrative(playerCharacter.name, target.name, weapon, toCombatResult(result), target.maxHp);
  console.log(`  📖 ${narrative}`);
  addMessage("旁白", narrative, "narration");
  turnMessages.push({ speaker: "旁白", content: narrative, type: "narration" });

  // KP 跟进（使用世界状态上下文）
  const kpNarration = await kp.narrateOutcome(
    `攻击${target.name}`,
    result.hit
      ? (result.result === "kill" ? `${target.name}被击杀` : `${target.name}受伤`)
      : "攻击未命中",
    getPlayerHistory()
  );
  console.log(`  🎭 ${kpNarration}`);
  addMessage("KP", kpNarration, "narration");
  turnMessages.push({ speaker: "KP", content: kpNarration, type: "narration" });
}

// ============================================================
// 移动 / 自由叙事
// ============================================================

async function handleMovement(
  intent: any, turnMessages: AgentMessage[]
) {
  const msg = `向 ${intent.target || "前方"} 移动`;
  world.logEvent({ round, timestamp: Date.now(), event_type: "move", actor: "player", description: msg });

  const targetScene = intent.target as string | undefined;
  if (targetScene) {
    world.getDatabase().prepare("UPDATE entities SET scene_id=?, position=? WHERE id='player'").run(targetScene, targetScene);
    world.setActiveScene(targetScene);
    kp.updateDirective({ scene_description: targetScene });
  }

  const narration = await kp.narrateOutcome(msg, "玩家移动", getPlayerHistory());
  console.log(`  🚶 ${narration}`);
  addMessage("KP", narration, "narration");
  turnMessages.push({ speaker: "KP", content: narration, type: "narration" });

  // 新场景中的 NPC 可能主动说话
  const playerScene = targetScene || INITIAL_SCENE;
  const nearby = world.getEntitiesInScene(playerScene).filter(e => e.type === "npc" && e.id !== "player");
  for (const entity of nearby) {
    const npc = registry.get(entity.name);
    if (npc && Math.random() < 0.4) {
      const speak = await npc.speakUp("有陌生人进入了你的区域", getPlayerHistory(), {
        sceneId: world.getCurrentState().scene, ruleset: activeRuleset as RulesetId,
      });
      console.log(`  💬 ${entity.name}: ${speak}`);
      addMessage(entity.name, speak);
      turnMessages.push({ speaker: entity.name, content: speak, type: "dialogue" });
    }
  }
}

async function handleFreeNarration(input: string, turnMessages: AgentMessage[]) {
  const kpNarration = await kp.narrateOutcome(input, `玩家: ${input}`, getPlayerHistory());
  console.log(`  🎭 ${kpNarration}`);
  addMessage("KP", kpNarration, "narration");
  turnMessages.push({ speaker: "KP", content: kpNarration, type: "narration" });

  // NPC 回应
  for (const npc of registry.getAll()) {
    if (input.includes(npc.name)) {
      const response = await npc.respond(
        `调查员对我说: "${input}"。KP的旁白: "${kpNarration}"`,
        getPlayerHistory(),
        { sceneId: world.getCurrentState().scene, ruleset: activeRuleset as RulesetId },
      );
      console.log(`  💬 ${npc.name}: ${response}`);
      addMessage(npc.name, response, "dialogue");
      turnMessages.push({ speaker: npc.name, content: response, type: "dialogue" });
      break;
    }
  }

  // NPC 主动发言
  const agents = registry.getAll();
  if (Math.random() < 0.3 && agents.length > 0) {
    const randomNpc = agents[Math.floor(Math.random() * agents.length)];
    const speakUp = await randomNpc.speakUp("KP刚描述了新进展", getPlayerHistory(), {
      sceneId: world.getCurrentState().scene, ruleset: activeRuleset as RulesetId,
    });
    if (speakUp && !speakUp.includes("没什么可说") && !speakUp.includes("保持沉默")) {
      console.log(`  💬 ${randomNpc.name}(主动): ${speakUp}`);
      addMessage(randomNpc.name, speakUp, "dialogue");
      turnMessages.push({ speaker: randomNpc.name, content: speakUp, type: "dialogue" });
    }
  }
}

// ============================================================
// 调查处理（多技能路径）
// ============================================================

async function handleInvestigation(
  input: string,
  turnMessages: AgentMessage[],
) {
  const activePlayer = session.getActive();
  const playerName = activePlayer?.name ?? "p1";

  // 根据输入推断线索类型
  let clueType = "document";
  if (input.includes("尸体") || input.includes("死") || input.includes("伤")) clueType = "corpse_clue";
  else if (input.includes("雕像") || input.includes("古董") || input.includes("文物")) clueType = "antique_object";
  else if (input.includes("仪式") || input.includes("法阵") || input.includes("符号") || input.includes("图案")) clueType = "ritual_site";

  // ── CoC 7e 路径：使用角色实际技能 + CoC 百分位检定 ──
  if (activeRuleset === "cosmic-horror" && cocCharacter) {
    const attrs = cocCharacter.attributes;
    const cocSkills: Record<string, number> = {};
    const skillKeys = ["medicine", "history", "occult", "spot_hidden", "psychology", "library_use", "appraise", "art", "chemistry", "education", "science_chemistry", "anthropology", "archaeology", "forensic", "language_other", "navigate", "natural_history"];
    for (const key of skillKeys) {
      cocSkills[key] = getSkillValue(cocCharacter.occupationSkills, cocCharacter.skillValues, key)
        || getBaseSkillValue(key, attrs.dexterity, attrs.education);
    }

    const result = investigation.investigateCoC(clueType, cocSkills, playerName);

    console.log(`  🔍 [CoC] ${result.revelation.split("\n")[0]}`);
    console.log(`  🎲 ${result.skillValue}% → d100=${result.roll} → ${SUCCESS_LEVEL_LABELS[result.successLevel] ?? result.successLevel}`);

    if (result.sanLost > 0) {
      // ⚠ 原先是 `sanity.state.currentSAN = Math.max(0, ... - result.sanLost)` ——
      //   **直接赋值字段，绕过引擎**。而临时疯狂（单次 ≥5）、不定疯狂（累计 20%）、
      //   疯狂表、恐惧症/狂躁症全都在引擎里，于是调查线索掉的 SAN 永远不会让人发疯。
      //   `1/1d6` 失败时有 1/3 概率掷出 5 或 6，够得着。
      const san = sanity.applyLoss(result.sanLost);
      console.log(`  🧠 SAN -${san.sanLoss} (当前 ${sanity.state.currentSAN}/${sanity.state.maxSAN})`);
      if (san.temporaryInsanityTriggered) {
        console.log(`  ⚠️ 临时疯狂触发！${san.boutOfMadness ?? ""}`);
      }
      if (san.indefiniteInsanityTriggered) {
        console.log(`  ⚠️ 不定性疯狂（${san.indefiniteLevel ?? ""}）——你已经不是进来时的那个人了。`);
      }
    }

    // 信息层：即使失败也提供有限信息（YAML 中定义了 fail 文本）
    addMessage("KP", result.revelation, "narration", "scene_restricted", playerName);
    turnMessages.push({ speaker: "KP", content: result.revelation, type: "narration" });

    if (result.sanLost > 0) {
      const sanMsg = `[调查 SAN 损失] ${result.sanCost}: SAN -${result.sanLost}`;
      addMessage("系统", sanMsg, "system");
    }
    return;
  }

  // ── D&D 路径（原有逻辑）──
  const playerSkills: Record<string, number> = {
    medicine: 35, history: 25, occult: 20, spot_hidden: 45,
    psychology: 30, library_use: 35, appraise: 15, art: 10,
    chemistry: 10, education: 40, science_chemistry: 10,
  };

  const state = world.getCurrentState();
  const playerScene = state.entities["player"]?.position ?? INITIAL_SCENE;
  const nearbyNPCs = Object.values(state.entities)
    .filter((e) => e.type === "npc" && e.position === playerScene)
    .map((e) => e.name);

  const result = investigation.investigate(
    clueType, playerSkills, nearbyNPCs, playerName, ruleEngine
  );

  console.log(`  🔍 调查: ${result.clue_description}`);
  if (result.combined_triggered) {
    console.log(`  ✨ 组合阈值触发——知识完整拼图！`);
  } else if (result.primary_result) {
    const pr = result.primary_result;
    console.log(`  🎲 ${pr.skillName}: d20=${pr.roll} vs DC${pr.dc} → ${pr.success ? "成功" : "失败"}${pr.critical ? " 暴击" : ""}`);
  }
  console.log(`  📖 ${result.final_revelation.split("\n")[0]}`);

  const visibility: VisibilityRule = result.is_critical ? "discoverer_only" : "scene_restricted";
  addMessage("KP", result.final_revelation, "narration", visibility, playerName);
  turnMessages.push({ speaker: "KP", content: result.final_revelation, type: "narration" });

  if (result.fallback_triggered) {
    const msg = "（预设 fallback：所有检定路径均失败，触发新线索浮现。）";
    addMessage("系统", msg, "system", "public");
    turnMessages.push({ speaker: "系统", content: msg, type: "system" });
  }
}

// ============================================================
// NPC 行动裁决（与玩家同一律书管线）
// ============================================================

async function resolveNPCAction(
  npc: WorldEntity,
  intent: any,
  turnMessages: AgentMessage[]
) {
  const target = world.getEntity(intent.target);
  if (!target) return;

  const npcAttacker = {
    name: npc.name,
    id: npc.id,
    proficiency: 2,
    abilities: { strength: 14, dexterity: 12, constitution: 14, intelligence: 8, wisdom: 10, charisma: 6 },
    hasSneakAttack: false,
  };

  const weapon = intent.weapon || "shortsword";

  // CoC: NPC 技能推定
  let npcSkill: number | undefined;
  let npcDodge: number | undefined;
  if (activeRuleset === "cosmic-horror") {
    // 这两个数字提到 game-session 里做了常量 —— GameSession 接上「敌人还手」之后
    // 两处都要用它们，各写一份迟早漂。
    npcSkill = intent.weapon ? NPC_ARMED_SKILL : NPC_UNARMED_SKILL;
    npcDodge = Math.floor(((npcAttacker.abilities.dexterity ?? 10) / 10) * 8);
  }

  // 律书判定——NPC 与玩家共用路由引擎
  const result = rules.adjudicateAttack(
    intent, npcAttacker,
    { id: target.id, name: target.name, hp: target.hp, ac: target.ac, type: target.type, maxHp: target.maxHp, status: target.status, position: target.position },
    activeRuleset as RulesetId,
    false, false, intent.weapon || "shortsword",
    npcSkill, npcDodge
  );

  if (result.hit) {
    const { killed } = world.applyDamage(target.id, result.damage);
    world.logCombatEvent(round, npc.id, target.id,
      `${npc.name} 攻击 ${target.name}，造成 ${result.damage} 点伤害`,
      toCombatResult(result)
    );
    if (killed) {
      world.logEvent({ round, timestamp: Date.now(), event_type: "system", description: `${target.name} 被 ${npc.name} 击杀` });
      if (registry.has(target.name)) {
        registry.unregister(target.name);
        console.log(`  🔌 ${target.name} Agent 已自动注销`);
      }
    }
  }

  // 叙事
  const narrative = await generateNarrative(npc.name, target.name, weapon, toCombatResult(result), target.maxHp);
  console.log(`  ⚔ ${narrative}`);
  addMessage("旁白", narrative, "narration");
  turnMessages.push({ speaker: "旁白", content: narrative, type: "narration" });
}

// ============================================================
// 热插拔 CLI 命令
// ============================================================

function handleNPCCommand(input: string, rl: any) {
  const parts = input.slice(5).trim().split(/\s+/);
  const sub = parts[0];

  if (sub === "list") {
    const names = registry.getAllNames();
    if (names.length === 0) {
      console.log("  ℹ 无已注册 Agent");
    } else {
      console.log(`  📋 已注册 Agent (${registry.count}):`);
      for (const name of names) {
        const a = registry.get(name)!;
        console.log(`    ${name} [${a.personality.role}] — ${a.personality.personality.slice(0, 40)}...`);
      }
    }
  } else if (sub === "remove" && parts[1]) {
    const name = parts[1];
    if (registry.unregister(name)) {
      console.log(`  ✅ Agent "${name}" 已注销`);
    } else {
      console.log(`  ⚠ 未找到 Agent: ${name}`);
    }
  } else if (sub === "add" && parts.length >= 3) {
    const name = parts[1];
    const role = parts[2];
    const personality = parts.slice(3).join(" ") || "普通路人";
    try {
      // 要的是注册这个副作用，返回的 agent 用不上 —— 不接它，免得看着像忘了用
      registry.registerQuick(name, role, personality);
      console.log(`  ✅ Agent "${name}" [${role}] 已注册并激活`);
    } catch (err: any) {
      console.log(`  ❌ 注册失败: ${err.message}`);
    }
  } else {
    console.log("  用法:");
    console.log("    /npc add <名> <身份> <性格>  — 快速注册 NPC");
    console.log("    /npc remove <名>              — 注销 NPC");
    console.log("    /npc list                     — 列出所有 Agent");
  }
  rl.prompt();
}

// ============================================================
// 主循环
// ============================================================

async function main() {
  console.clear();
  console.log("═".repeat(60));
  console.log("  AI Narrator — 多 Agent 引擎（含世界状态管理器）");
  console.log("═".repeat(60));
  console.log(`  LLM: ${config.model}`);
  console.log(`  NPC: ${registry.getAllNames().join("、")}`);
  console.log(`  世界: ${world.getAllAliveEntities().length} 实体已就绪`);
  console.log(`  玩家: ${session.getAllNames().join("、")} | 当前: ${session.getActive()?.name ?? "无"}`);
  console.log(`  DB: SQLite (WAL mode, :memory:)`);
  console.log("═".repeat(60));

  // 初始快照
  world.logEvent({ round: 0, timestamp: Date.now(), event_type: "system", description: "游戏开始" });
  const initCtx = world.createSnapshot(0);
  const initTokens = Math.ceil(initCtx.length / 2.5);
  console.log(`  📸 初始快照: ${initCtx.length} 字符 ≈ ${initTokens} tokens`);

  // 开场场景
  console.log("\n  📖 开场:");
  const opening = await kp.describeScene();
  console.log(`  ${opening}`);
  addMessage("KP", opening, "narration");

  // 互动
  const rl = createInterface({
    input: process.stdin, output: process.stdout,
    prompt: `\n🎲 [${session.getActive()?.name ?? "?"}] 你要怎么做？ `,
  });
  console.log("\n  💡 /create <职业> [名] | /horror-create <职业> [名] | /sheet | 调查 检查 | 快照 /wm");
  console.log("     /规则 dnd|coc | /push <技能> | /luck <点数> <技能> | /reload");
  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();
    if (!input) { rl.prompt(); continue; }
    if (input === "退出" || input === "exit" || input === "quit") {
      console.log("\n  🌙 游戏结束。\n");
      break;
    }
    if (input === "状态" || input === "status") {
      const active = session.getActive();
      console.log(`\n  📊 回合: ${round} | 规则: ${activeRuleset}`);
      console.log(`  场景: ${kp.getDirective().current_phase}`);
      console.log(`  当前玩家: ${active?.name ?? "无"}`);
      if (activeRuleset === "cosmic-horror" && cocCharacter) {
        console.log(`  角色: ${cocCharacter.name} [${cocCharacter.archetypeId}] HP:${cocCharacter.hp}/${cocCharacter.maxHp} SAN:${sanity.state.currentSAN}/${sanity.state.maxSAN} 幸运:${cocCharacter.luck}`);
        console.log(`  CM:${sanity.state.cthulhuMythos}%${sanity.state.temporaryInsanity ? " [临时疯狂!]" : ""}${sanity.state.indefiniteInsanity ? ` [${sanity.state.indefiniteLevel}不定疯狂]` : ""}`);
        if (sanity.state.phobias.length > 0) console.log(`  恐惧症: ${sanity.state.phobias.join(", ")}`);
        if (sanity.state.manias.length > 0) console.log(`  狂躁症: ${sanity.state.manias.join(", ")}`);
        if (cocAmmo.size > 0) {
          const ammoStr = [...cocAmmo.entries()].map(([k, v]) => `${k}: ${v.current}/${v.max}`).join(" | ");
          console.log(`  🔫 弹药: ${ammoStr}`);
        }
      } else {
        console.log(`  SAN: ${sanity.state.currentSAN}/${sanity.state.maxSAN}${sanity.state.temporaryInsanity ? " [临时疯狂!]" : ""}`);
      }
      console.log(`  消息: ${getPlayerHistory().length} 条 | Agent: ${registry.count} 个`);
      for (const npc of registry.getAll()) {
        console.log(`    ${npc.name}: ${npc.getRecentMemories(2).length} 条记忆`);
      }
      rl.prompt(); continue;
    }
    if (input === "快照" || input === "snap") {
      const ctx = world.getLatestContext();
      console.log(`\n  📸 最新快照上下文:\n${divider()}\n${ctx}\n${divider()}`);
      console.log(`  ${ctx.length} 字符 ≈ ${Math.ceil(ctx.length / 2.5)} tokens`);
      rl.prompt(); continue;
    }
    if (input === "实体" || input === "entities") {
      const entities = world.getAllAliveEntities();
      console.log(`\n  📋 存活实体 (${entities.length}):`);
      for (const e of entities) {
        const hasAgent = registry.has(e.name) ? " [Agent]" : "";
        console.log(`  - ${e.name} [${e.type}] HP:${e.hp}/${e.maxHp} AC:${e.ac} 位置:${e.position}${hasAgent}`);
      }
      rl.prompt(); continue;
    }
    if (input === "/wm" || input === "世界模型") {
      const stats = worldModel.getStats();
      const topNovels = Object.entries(stats.byNovel)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 6)
        .map(([n, c]) => `${n.slice(0, 12)}(${c.toLocaleString()})`)
        .join(", ");
      console.log(`\n  🌐 世界模型 v18 (${stats.total.toLocaleString()} 条, ${Object.keys(stats.byNovel).length} 部小说):`);
      console.log(`  前 6 小说: ${topNovels}`);
      console.log(`  类型: causal ${(stats.byType.causal || 0).toLocaleString()} | behavior ${(stats.byType.behavior || 0).toLocaleString()} | resource ${(stats.byType.resource || 0).toLocaleString()}`);
      console.log(`  类型续: faction ${(stats.byType.faction_relation || 0).toLocaleString()} | combat ${(stats.byType.combat || 0).toLocaleString()} | strategy ${(stats.byType.strategy || 0).toLocaleString()}`);
      console.log(`  D&D 规则: ${stats.dndGameRules.toLocaleString()} | D&D 映射: ${stats.dndMappings.toLocaleString()} | 幻觉风险: ${stats.hallucinationRisky}`);
      rl.prompt(); continue;
    }
    // ── /horror-create 创建 CoC 调查员 ──
    if (input.startsWith("/horror-create ") || input === "/horror-create") {
      const parts = input.startsWith("/horror-create ") ? input.slice(15).trim().split(/\s+/) : [];
      if (parts.length < 1) {
        const archs = getCoCArchetypes();
        console.log(`\n  📋 可用 CoC 职业 (${archs.length} 个):`);
        for (const a of archs.slice(0, 15)) {
          console.log(`    ${a.id}: ${a.label} — ${(a.description || "").slice(0, 50)}`);
        }
        if (archs.length > 15) console.log(`    ... 还有 ${archs.length - 15} 个职业`);
        console.log(`  用法: /horror-create <职业id> [角色名]`);
        console.log(`  示例: /horror-create investigator 张明`);
        rl.prompt(); continue;
      }
      const archetypeId = parts[0];
      const charName = parts.slice(1).join(" ") || archetypeId;
      const archetype = getCoCArchetypes().find(a => a.id === archetypeId);
      if (!archetype) {
        console.log(`  ❌ 未知 CoC 职业: ${archetypeId}`);
        console.log(`  可用: ${getCoCArchetypes().map(a => a.id).join(", ")}`);
        rl.prompt(); continue;
      }
      try {
        const cocChar = await createCoCCharacter(
          { name: charName, archetypeId, method: "point_buy" },
          archetype
        );
        cocCharacter = cocChar;
        const power = cocChar.attributes.power ?? 50;
        sanity.restoreState({ ...sanity.state, currentSAN: power, maxSAN: power });
        activeRuleset = "cosmic-horror";
        console.log(`\n  📜 ${cocChar.name} [${archetype.label}] - CoC 7e`);
        console.log(`  HP:${cocChar.hp}  AC:${cocChar.ac}  MOV:${cocChar.move}  DB:${cocChar.damageBonus}`);
        console.log(`  属性: STR=${cocChar.attributes.strength} CON=${cocChar.attributes.constitution} SIZ=${cocChar.attributes.size}`);
        console.log(`        DEX=${cocChar.attributes.dexterity} APP=${cocChar.attributes.appearance} INT=${cocChar.attributes.intelligence}`);
        console.log(`        POW=${cocChar.attributes.power} EDU=${cocChar.attributes.education}`);
        console.log(`  幸运:${cocChar.luck} 信用评级:${cocChar.creditRating} 伤害加值:${cocChar.damageBonus}`);
        if (cocChar.cthulhuMythos > 0) console.log(`  CM:${cocChar.cthulhuMythos}%`);
        if (cocChar.warnings.length > 0) console.log(`  ⚠ ${cocChar.warnings.join("; ")}`);
      } catch (err: any) {
        console.log(`  ❌ 创建失败: ${err.message}`);
      }
      rl.prompt(); continue;
    }
    // ── /horror-check 技能检定 ──
    if ((input.startsWith("/horror-check ") || input.startsWith("/cc ")) && activeRuleset === "cosmic-horror") {
      const skillName = (input.startsWith("/horror-check ") ? input.slice(14) : input.slice(4)).trim();
      if (!cocCharacter) {
        console.log("  ❌ 请先使用 /horror-create 创建角色");
        rl.prompt(); continue;
      }
      if (!skillName) {
        console.log("  用法: /horror-check <技能名/key>");
        console.log(`  可用 key: fighting, firearms_pistol, spot_hidden, listen, stealth, library_use, occult, psychology, medicine, dodge, persuade, fast_talk, intimidate, etc.`);
        rl.prompt(); continue;
      }
      const label = KEY_TO_LABEL[skillName] || skillName;
      const skillValue = getSkillValue(cocCharacter.occupationSkills, cocCharacter.skillValues, skillName) || getBaseSkillValue(skillName, cocCharacter.attributes.dexterity, cocCharacter.attributes.education);
      if (skillValue <= 0) {
        console.log(`  ⚠ 未找到技能 "${skillName}"`);
        rl.prompt(); continue;
      }
      const result = CoCEngine.skillCheck(skillValue, "regular");
      console.log(`  🎲 [CoC] ${label}(${skillValue}%): ${result.description}`);
      const msg = `技能检定: ${label} d100=${result.roll} vs ${skillValue} → ${result.successLevel}`;
      addMessage("系统", msg, "system");
      rl.prompt(); continue;
    }
    // ── /push 推动检定 ──
    if ((input.startsWith("/push ") || input === "/push") && activeRuleset === "cosmic-horror") {
      const skillName = input === "/push" ? "" : input.slice(6).trim();
      if (!cocCharacter) {
        console.log("  ❌ 请先使用 /horror-create 创建角色");
        rl.prompt(); continue;
      }
      if (!skillName) {
        console.log("  用法: /push <技能名>   — 推动检定（失败后果更严重）");
        console.log("  示例: /push spot_hidden");
        rl.prompt(); continue;
      }
      const label = KEY_TO_LABEL[skillName] || skillName;
      const skillValue = getSkillValue(cocCharacter.occupationSkills, cocCharacter.skillValues, skillName) || getBaseSkillValue(skillName, cocCharacter.attributes.dexterity, cocCharacter.attributes.education);
      if (skillValue <= 0) {
        console.log(`  ⚠ 未找到技能 "${skillName}"`);
        rl.prompt(); continue;
      }
      const result = CoCEngine.skillCheck(skillValue, "regular", 0, 0, 0, true);
      const pushNote = result.isSuccess
        ? "  💪 推动检定成功！"
        : "  💥 推动检定失败 — KP 可给予严重后果（受伤/线索永久丢失等）";
      console.log(`  🎲 [CoC 推动] ${label}(${skillValue}%): ${result.description}`);
      console.log(pushNote);
      rl.prompt(); continue;
    }
    // ── /luck 燃运 ──
    if ((input.startsWith("/luck ") || input.startsWith("/cc-luck ")) && activeRuleset === "cosmic-horror") {
      const parts = (input.startsWith("/luck ") ? input.slice(6) : input.slice(9)).trim().split(/\s+/);
      if (parts.length < 2) {
        console.log("  用法: /luck <点数> <技能名>   — 消耗幸运降低骰值");
        console.log("  示例: /luck 10 spot_hidden  — 消耗 10 点幸运补正侦查");
        rl.prompt(); continue;
      }
      const luckAmount = parseInt(parts[0]);
      if (isNaN(luckAmount) || luckAmount < 1) {
        console.log("  ❌ 请输入有效的幸运点数");
        rl.prompt(); continue;
      }
      const skillName = parts.slice(1).join(" ");
      if (!cocCharacter) {
        console.log("  ❌ 请先使用 /horror-create 创建角色");
        rl.prompt(); continue;
      }
      if (luckAmount > cocCharacter.luck) {
        console.log(`  ❌ 幸运不足 (当前 ${cocCharacter.luck})`);
        rl.prompt(); continue;
      }
      const label = KEY_TO_LABEL[skillName] || skillName;
      const skillValue = getSkillValue(cocCharacter.occupationSkills, cocCharacter.skillValues, skillName) || getBaseSkillValue(skillName, cocCharacter.attributes.dexterity, cocCharacter.attributes.education);
      if (skillValue <= 0) {
        console.log(`  ⚠ 未找到技能 "${skillName}"`);
        rl.prompt(); continue;
      }
      const result = CoCEngine.skillCheck(skillValue, "regular", 0, 0, luckAmount);
      cocCharacter.luck -= luckAmount;
      console.log(`  🎲 [CoC 燃运-${luckAmount}] ${label}(${skillValue}%): ${result.description}`);
      console.log(`  🍀 剩余幸运: ${cocCharacter.luck}`);
      rl.prompt(); continue;
    }
    // ── /reload 装弹 ──
    if (input === "/reload" && activeRuleset === "cosmic-horror") {
      if (cocAmmo.size === 0) {
        console.log("  ℹ 没有需要装弹的武器");
      } else {
        for (const [key, ammo] of cocAmmo) {
          ammo.current = ammo.max;
          console.log(`  🔄 ${key} 已装填完毕 (${ammo.current}/${ammo.max})`);
        }
      }
      rl.prompt(); continue;
    }
    // ── /create 创角 ──
    if (input.startsWith("/create ")) {
      const parts = input.slice(8).trim().split(/\s+/);
      if (parts.length < 1) {
        console.log(`  可用: ${CharacterFactory.listArchetypes(activeRuleset).map(a=>`${a.id}(${a.label})`).join(", ")}`);
        rl.prompt(); continue;
      }
      const archetypeId = parts[0];
      const charName = parts.slice(1).join(" ") || archetypeId;
      try {
        activeCharacter = CharacterFactory.generate(charName, archetypeId, activeRuleset);
        const acCreate = CharacterFactory.computeAC(activeCharacter);
        console.log(`\n  📜 ${activeCharacter.name} [${activeArchetypeLabel()}]`);
        console.log(`  HP:${activeCharacter.hp} AC:${acCreate}`);
        console.log(`  属性: ${Object.entries(activeCharacter.attributes).map(([k,v])=>`${k}=${v}`).join(" ")}`);
        if (activeCharacter.warnings.length > 0) console.log(`  ⚠ ${activeCharacter.warnings.join("; ")}`);
      } catch (err: any) { console.log(`  ❌ ${err.message}`); }
      rl.prompt(); continue;
    }
    if (input === "/sheet" || input === "角色卡") {
      if (activeRuleset === "cosmic-horror" && cocCharacter) {
        const c = cocCharacter;
        console.log(`\n  📜 ${c.name} [${c.archetypeId}]`);
        console.log(`  HP:${c.hp}/${c.maxHp} AC:${c.ac} MOV:${c.move} DB:${c.damageBonus}`);
        console.log(`  属性: STR=${c.attributes.strength} CON=${c.attributes.constitution} SIZ=${c.attributes.size} DEX=${c.attributes.dexterity}`);
        console.log(`        APP=${c.attributes.appearance} INT=${c.attributes.intelligence} POW=${c.attributes.power} EDU=${c.attributes.education}`);
        console.log(`  幸运:${c.luck} 信用评级:${c.creditRating} 年龄:${c.age}`);
        console.log(`  SAN: ${sanity.state.currentSAN}/${sanity.state.maxSAN} CM:${sanity.state.cthulhuMythos}%`);
        // 显示关键技能
        const keySkills = ["fighting", "firearms_pistol", "firearms_rifle", "spot_hidden", "listen", "stealth", "library_use", "occult", "psychology", "medicine", "dodge"];
        const skillLines = keySkills
          .map(k => {
            const val = getSkillValue(c.occupationSkills, c.skillValues, k) || getBaseSkillValue(k, c.attributes.dexterity, c.attributes.education);
            const label = k === "fighting" ? "格斗" : k === "firearms_pistol" ? "射击(手枪)" : k === "firearms_rifle" ? "射击(步枪)" : k === "spot_hidden" ? "侦查" : k === "listen" ? "聆听" : k === "stealth" ? "潜行" : k === "library_use" ? "图书馆" : k === "occult" ? "神秘学" : k === "psychology" ? "心理学" : k === "medicine" ? "医学" : k === "dodge" ? "闪避" : k;
            return `${label}=${val}%`;
          })
          .join(" ");
        console.log(`  技能: ${skillLines}`);
        if (c.startingItems.length > 0) console.log(`  物品: ${c.startingItems.join(", ")}`);
        if (cocAmmo.size > 0) {
          const ammoStr = [...cocAmmo.entries()].map(([k, v]) => `${k} ${v.current}/${v.max}发`).join(", ");
          console.log(`  🔫 弹药: ${ammoStr}`);
        }
        if (c.warnings.length > 0) console.log(`  ⚠ ${c.warnings.join("; ")}`);
        // 疯狂状态
        const guidance = sanity.getFullGuidance();
        if (guidance !== "你的神智目前清醒。") console.log(`  🧠 ${guidance.slice(0, 80)}...`);
      } else if (activeCharacter) {
        const acSheet = CharacterFactory.computeAC(activeCharacter);
        console.log(`\n  📜 ${activeCharacter.name} [${activeArchetypeLabel()}]`);
        console.log(`  HP:${activeCharacter.hp}/${activeCharacter.maxHp} AC:${acSheet} Lv:${activeCharacter.totalLevel} BAB:${activeCharacter.baseAttackBonus}`);
        // 原先这里打印「基础 AC X + 特性 Y」，但 GeneratedCharacter 没有 ac 字段，
        // 而 computeAC 就是 10+敏捷调整值、不含任何特性加成，所以那行只会输出
        // "基础 AC undefined + 特性 NaN"。特性加成需要 accumulateEffects 真正实现后再加回。
        console.log(`  属性: ${Object.entries(activeCharacter.attributes).map(([k,v])=>`${k}=${v}`).join(" ")}`);
        console.log(`  技能: ${activeCharacter.skills.join(", ")}`);
        if (activeCharacter.classLevels.size > 1) {
          console.log(`  职业等级: ${[...activeCharacter.classLevels].map(([id,lv])=>`${id} Lv${lv}`).join(", ")}`);
        }
        if (activeCharacter.activeFeatures.length > 0) {
          console.log(`  特性: ${activeCharacter.activeFeatures.map(f=>`${f.name}`).join(", ")}`);
        }
        if (activeCharacter.selectedFeats.length > 0) {
          console.log(`  专长: ${activeCharacter.selectedFeats.join(", ")}`);
        }
        // 特性效果汇总（攻击/伤害/AC/豁免加成）待 CharacterFactory.accumulateEffects
        // 真正实现后再接回来：它目前是 `return []` 的空桩，这里读 effects.attackBonus
        // 之类的字段在数组上永远是 undefined，整段展示从来没有输出过内容。
      } else { console.log("  ℹ 使用 /create <职业id> [角色名] 或 /horror-create <职业id> [角色名] 创建角色"); }
      rl.prompt(); continue;
    }
    // ── /advance 进阶职业 ──
    if (input.startsWith("/advance ")) {
      if (!activeCharacter) { console.log("  ❌ 请先创建角色: /create <职业id>"); rl.prompt(); continue; }
      const prestigeId = input.slice(9).trim();
      try {
        const { eligible, missing } = CharacterFactory.canTakePrestige(activeCharacter, prestigeId);
        if (!eligible) {
          console.log(`  ❌ 不满足先决条件: ${missing.join("; ")}`);
          rl.prompt(); continue;
        }
        activeCharacter = CharacterFactory.advance(activeCharacter, prestigeId, 1);
        console.log(`  ⬆ 进阶成功! ${activeCharacter.name} 成为 ${activeArchetypeLabel()} Lv${activeCharacter.classLevels.get(prestigeId)}`);
        console.log(`  总等级: ${activeCharacter.totalLevel} | BAB: ${activeCharacter.baseAttackBonus}`);
        if (activeCharacter.activeFeatures.length > 0) {
          console.log(`  新特性: ${activeCharacter.activeFeatures.slice(-3).map(f=>`${f.name}(${f.description.slice(0,30)}...)`).join(", ")}`);
        }
        // 检查是否到达专长选择等级
        const prestigeFeatChoices = activeArchetype()?.featChoices;
        if (prestigeFeatChoices) {
          for (const fc of prestigeFeatChoices) {
            const alreadyChosen = activeCharacter.selectedFeats.some(sf => fc.options.some(o => o.name === sf));
            if (fc.level <= activeCharacter.totalLevel && !alreadyChosen) {
              const options = fc.options.map(o => o.name).join("、");
              console.log(`  💡 达到 Lv${fc.level}！可用 /choose-feat 从以下专长中选择: ${options}`);
            }
          }
        }
      } catch (err: any) { console.log(`  ❌ ${err.message}`); }
      rl.prompt(); continue;
    }
    // ── /level 升级当前职业 ──
    if (input.startsWith("/level ")) {
      if (!activeCharacter) { console.log("  ℹ 使用 /create <职业id> 创建角色"); rl.prompt(); continue; }
      const levels = parseInt(input.slice(7).trim()) || 1;
      activeCharacter.totalLevel += levels;
      // 更新当前子职等级
      const classId = activeCharacter.archetype;
      const current = activeCharacter.classLevels.get(classId) ?? 1;
      activeCharacter.classLevels.set(classId, current + levels);
      // 增加 HP
      for (let i = 0; i < levels; i++) {
        activeCharacter.maxHp += Math.floor(Math.random() * 6) + 1;
      }
      activeCharacter.hp = activeCharacter.maxHp;
      // 激活新等级的 levelFeatures
      // 取一次存下来再用：判空和遍历各调一次 activeArchetype()，中间没有任何东西
      // 保证两次返回同一个对象，判空的结论对遍历那次不成立。
      const levelFeatures = activeArchetype()?.levelFeatures;
      if (levelFeatures) {
        const oldCount = activeCharacter.activeFeatures.length;
        for (const lf of levelFeatures) {
          if (lf.level <= activeCharacter.totalLevel && !activeCharacter.activeFeatures.some(f => f.name === lf.name)) {
            activeCharacter.activeFeatures.push(lf);
          }
        }
        if (activeCharacter.activeFeatures.length > oldCount) {
          console.log(`  ⚡ 新特性解锁！`);
        }
      }
      console.log(`  ⬆ ${activeCharacter.name} 升至 Lv${activeCharacter.totalLevel}！HP:${activeCharacter.maxHp}`);
      // 提示专长选择
      const levelFeatChoices = activeArchetype()?.featChoices;
      if (levelFeatChoices) {
        for (const fc of levelFeatChoices) {
          const alreadyChosen = activeCharacter.selectedFeats.some(sf => fc.options.some(o => o.name === sf));
          if (fc.level <= activeCharacter.totalLevel && !alreadyChosen) {
            const options = fc.options.map(o => o.name).join("、");
            console.log(`  💡 达到 Lv${fc.level}！可用 /choose-feat 从以下专长中选择: ${options}`);
          }
        }
      }
      rl.prompt(); continue;
    }
    // ── /prestige 列出进阶职业 ──
    if (input === "/prestige" || input === "进阶职业") {
      const prestige = CharacterFactory.listArchetypes(activeRuleset).filter(a => a.isPrestige);
      if (prestige.length === 0) { console.log("  ℹ 当前规则集无进阶职业"); rl.prompt(); continue; }
      console.log(`\n  🏰 进阶职业:`);
      for (const p of prestige) {
        const prereq = p.prerequisites
          ? `需要 Lv${p.prerequisites.minLevel ?? "?"} BAB${p.prerequisites.minBAB ?? "?"}`
          : "无条件";
        console.log(`    ${p.id}(${p.label}) — ${prereq} — ${(p.description ?? "").slice(0,40)}...`);
      }
      rl.prompt(); continue;
    }
    // ── /feats 查看专长 ──
    if (input === "/feats" || input === "专长") {
      if (!activeCharacter) { console.log("  ℹ 使用 /create <职业id> 创建角色"); rl.prompt(); continue; }
      const arch = activeArchetype();
      console.log(`\n  ⚔ ${activeArchetypeLabel()} 专长树`);
      // 已选专长（selectedFeats 存的是专长名字符串）
      if (activeCharacter.selectedFeats.length > 0) {
        console.log(`  ✅ 已选专长:`);
        for (const featName of activeCharacter.selectedFeats) {
          console.log(`    ${featName}`);
        }
      } else {
        console.log(`  ⚪ 尚未选择任何专长`);
      }
      // 可用选择点
      if (arch?.featChoices) {
        console.log(`  📋 专长选择点:`);
        for (const fc of arch.featChoices) {
          const alreadyChosen = activeCharacter.selectedFeats.some(sf => fc.options.some(o => o.name === sf));
          if (alreadyChosen) continue;
          const canTake = activeCharacter.totalLevel >= fc.level ? "" : ` (需 Lv${fc.level})`;
          console.log(`    Lv${fc.level} (选${fc.pick}):${canTake}`);
          for (const opt of fc.options) {
            const chosen = activeCharacter.selectedFeats.some(sf => sf === opt.name);
            const mark = chosen ? "✅" : (activeCharacter.totalLevel >= fc.level ? "  ·" : "  ·");
            console.log(`      ${mark} ${opt.name}: ${opt.description}`);
          }
        }
      } else {
        console.log(`  ℹ 该职业没有专长系统`);
      }
      rl.prompt(); continue;
    }
    // ── /choose-feat 选择专长 ──
    if (input.startsWith("/choose-feat ") || input.startsWith("/cf ")) {
      if (!activeCharacter) { console.log("  ℹ 使用 /create <职业id> 创建角色"); rl.prompt(); continue; }
      const featName = input.startsWith("/choose-feat ") ? input.slice(13).trim() : input.slice(4).trim();
      const result = CharacterFactory.chooseFeat(activeCharacter, featName);
      console.log(`  ${result.message}`);
      rl.prompt(); continue;
    }
    // ── 多玩家命令 ──
    if (input === "/players") {
      console.log(`\n  👥 玩家列表 (${session.count}):`);
      for (const p of session.getAll()) {
        const marker = p.name === session.getActive()?.name ? " ◀ 当前" : "";
        console.log(`    ${p.name} → ${p.characterName} [场景: ${session.getPlayerScene(p.name) ?? "未知"}]${marker}`);
      }
      rl.prompt(); continue;
    }
    if (input.startsWith("/join ")) {
      const name = input.slice(6).trim();
      try {
        session.join(name, name, `player_${name}`);
        // 在世界状态中注册新玩家实体
        world.upsertEntity({
          id: `player_${name}`, name, type: "pc", hp: 12, maxHp: 12, ac: 12, status: [],
          position: INITIAL_SCENE
        } as any);
        console.log(`  ✅ 玩家 "${name}" 加入游戏`);
      } catch (err: any) { console.log(`  ❌ ${err.message}`); }
      rl.prompt(); continue;
    }
    if (input.startsWith("/switch ")) {
      const name = input.slice(8).trim();
      if (session.switchActive(name)) {
        console.log(`  🔄 切换到玩家: ${name} (${session.getActive()?.characterName})`);
      } else {
        console.log(`  ⚠ 未找到玩家: ${name}`);
      }
      rl.prompt(); continue;
    }
    if (input.startsWith("/leave ")) {
      const name = input.slice(7).trim();
      if (session.count <= 1) {
        console.log("  ⚠ 至少需要一个玩家");
      } else if (session.leave(name)) {
        console.log(`  👋 玩家 "${name}" 离开游戏`);
      } else {
        console.log(`  ⚠ 未找到玩家: ${name}`);
      }
      rl.prompt(); continue;
    }
    if (input === "线索" || input === "clues") {
      const active = session.getActive();
      const discovered = investigation.getDiscoveredBy(active?.name ?? "p1");
      console.log(`\n  🔍 已发现线索 (${discovered.length}):`);
      if (discovered.length === 0) {
        console.log("    尚无发现。试试输入「检查尸体」「调查房间」等。");
      } else {
        for (const c of discovered) {
          console.log(`    - ${c}`);
        }
      }
      console.log(`  可用线索类型: ${investigation.listClueTypes().join(", ")}`);
      rl.prompt(); continue;
    }
    // ── /ref 规则速查 ──
    // 规则速查内容不再内置：由已加载模组或用户提供的规则书提供。
    if (input.startsWith("/ref")) {
      console.log("\n  ℹ 本系统不内置规则书速查内容。请查阅你自己的规则书，或加载包含规则说明的模组。");
      rl.prompt(); continue;
    }
    // ── /规则 切换规则集 ──
    if (input.startsWith("/规则 ") || input.startsWith("/ruleset ")) {
      const ruleset = input.split(/\s+/)[1];
      if (["dnd", "horror", "grail"].includes(ruleset)) {
        const map: Record<string, string> = { dnd: "dnd5e", horror: "cosmic-horror", grail: "grail" };
        activeRuleset = map[ruleset];
        console.log(`  ⚙ 规则集切换: ${activeRuleset}`);
      } else {
        console.log("  ⚠ 可用规则集: dnd | horror | grail");
      }
      rl.prompt(); continue;
    }
    // ── /novel 设置小说上下文 ──
    if (input.startsWith("/novel ")) {
      const novelName = input.slice(7).trim();
      if (novelName === "?" || novelName === "list") {
        const names = worldModel.getNovelNames();
        console.log(`\n  📚 可用小说 (${names.length} 部):`);
        for (const n of names.slice(0, 20)) {
          const count = worldModel.getByNovel(n).length;
          console.log(`    ${n} (${count.toLocaleString()} 条)`);
        }
        if (names.length > 20) console.log(`    ... 还有 ${names.length - 20} 部`);
        console.log(`  当前: ${activeNovel || "(未设置)"}`);
      } else {
        const exists = worldModel.getByNovel(novelName).length > 0;
        if (!exists) {
          // 模糊匹配
          const candidates = worldModel.getNovelNames().filter(n => n.includes(novelName));
          if (candidates.length === 1) {
            activeNovel = candidates[0];
            console.log(`  📖 小说上下文已设置: ${activeNovel}`);
          } else if (candidates.length > 1) {
            console.log(`  🔍 找到多个匹配: ${candidates.join(", ")}`);
            console.log(`  请使用完整名称: /novel "完整小说名"`);
          } else {
            console.log(`  ⚠ 未找到小说 "${novelName}"，使用 /novel list 查看`);
          }
        } else {
          activeNovel = novelName;
          console.log(`  📖 小说上下文已设置: ${activeNovel}`);
          const ns = worldModel.getNovelStats(activeNovel);
          console.log(`  ${ns.total.toLocaleString()} 条 | D&D 规则: ${ns.dndRules} | D&D 映射: ${ns.dndMappings}`);
        }
      }
      rl.prompt(); continue;
    }
    // ── /npc 热插拔命令 ──
    if (input.startsWith("/npc ")) {
      handleNPCCommand(input, rl);
      continue;
    }

    await handlePlayerInput(input);
    rl.prompt();
  }

  world.close();
  rl.close();
}

main().catch((err) => {
  log.error("cli", "致命错误:", err);
  process.exit(1);
});
