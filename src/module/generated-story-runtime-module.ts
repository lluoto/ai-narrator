/**
 * Converts the local rule-story generator's concrete output into the same
 * RuntimeModuleData package consumed by the existing direct runtime loader.
 *
 * This is intentionally not a document/PDF projection.  Its provenance says
 * exactly that: every source fact comes from the local rule templates selected
 * for this one generation.
 */
import { sha256 } from "../ingest/document-ir";
import type { GeneratedStory } from "../rules/story-generator";
import { validateRuntimeModuleDataForInstall } from "./module-data-runtime-loader";
import type { RuntimeModuleData } from "./types";

export const GENERATED_STORY_RUNTIME_MODULE_VERSION = "1.0.0" as const;
const GENERATED_STORY_SOURCE = "local-rule-generated-story-v1";

function nonBlank(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`generated story ${label} must be non-blank`);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const sorted = [...expected].sort();
  if (!sameStrings(actual, sorted)) throw new Error(`generated story ${label} does not exactly match its scenes`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`generated story ${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`generated story ${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`generated story ${label} must not contain symbols`);
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`generated story ${label}.${key} must be an enumerable data property`);
    }
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`generated story ${label} must be non-blank text`);
  return value;
}

function values(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`generated story ${label} must be an array`);
  if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`generated story ${label} must be a plain array without symbols`);
  }
  if (value.length > 10_000) throw new Error(`generated story ${label} exceeds the maximum array length`);
  const expected = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
  const own = Object.getOwnPropertyNames(value);
  if (own.length !== expected.size || own.some((key) => !expected.has(key))) {
    throw new Error(`generated story ${label} must not be sparse or contain extra properties`);
  }
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`generated story ${label}[${index}] must be an enumerable data property`);
    }
  }
  return value;
}

function textValues(value: unknown, label: string): string[] {
  return values(value, label).map((entry, index) => text(entry, `${label}[${index}]`));
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`generated story ${label} must be a safe integer`);
  return value;
}

/**
 * StoryGenerator is a runtime dependency, so its TypeScript return type is not
 * a runtime admission check. Validate every field that becomes package data
 * before conversion or hashing.
 */
function validateGeneratedStory(input: unknown): GeneratedStory {
  const story = record(input, "root");
  text(story.title, "title");
  text(story.hook, "hook");

  for (const [key, value] of Object.entries(record(story.displayNames, "displayNames"))) text(value, `displayNames.${key}`);
  for (const [key, value] of Object.entries(record(story.aliases, "aliases"))) text(value, `aliases.${key}`);
  for (const [key, value] of Object.entries(record(story.items, "items"))) textValues(value, `items.${key}`);

  for (const [index, value] of values(story.scenes, "scenes").entries()) {
    const scene = record(value, `scenes[${index}]`);
    text(scene.id, `scenes[${index}].id`);
    text(scene.name, `scenes[${index}].name`);
    text(scene.description, `scenes[${index}].description`);
    text(scene.lighting, `scenes[${index}].lighting`);
    textValues(scene.dangers, `scenes[${index}].dangers`);
    textValues(scene.items, `scenes[${index}].items`);
    textValues(scene.clues, `scenes[${index}].clues`);
    if (typeof scene.isActive !== "boolean") throw new Error(`generated story scenes[${index}].isActive must be boolean`);
    for (const [exitIndex, exitValue] of values(scene.exits, `scenes[${index}].exits`).entries()) {
      const exit = record(exitValue, `scenes[${index}].exits[${exitIndex}]`);
      text(exit.target, `scenes[${index}].exits[${exitIndex}].target`);
      text(exit.desc, `scenes[${index}].exits[${exitIndex}].desc`);
      if (typeof exit.locked !== "boolean") throw new Error(`generated story scenes[${index}].exits[${exitIndex}].locked must be boolean`);
    }
  }

  for (const [index, value] of values(story.entities, "entities").entries()) {
    const entity = record(value, `entities[${index}]`);
    text(entity.id, `entities[${index}].id`);
    text(entity.name, `entities[${index}].name`);
    if (entity.type !== "npc" && entity.type !== "monster") throw new Error(`generated story entities[${index}].type must be npc or monster`);
    safeInteger(entity.hp, `entities[${index}].hp`);
    safeInteger(entity.maxHp, `entities[${index}].maxHp`);
    safeInteger(entity.ac, `entities[${index}].ac`);
    textValues(entity.status, `entities[${index}].status`);
    text(entity.position, `entities[${index}].position`);
    text(entity.scene_id, `entities[${index}].scene_id`);
    text(entity.faction, `entities[${index}].faction`);
  }

  for (const [index, value] of values(story.clueTexts, "clueTexts").entries()) {
    const clue = record(value, `clueTexts[${index}]`);
    text(clue.id, `clueTexts[${index}].id`);
    text(clue.type, `clueTexts[${index}].type`);
    text(clue.category, `clueTexts[${index}].category`);
    text(clue.description, `clueTexts[${index}].description`);
    text(clue.scene, `clueTexts[${index}].scene`);
    text(clue.coc_primary, `clueTexts[${index}].coc_primary`);
    text(clue.coc_secondary, `clueTexts[${index}].coc_secondary`);
    text(clue.san_cost, `clueTexts[${index}].san_cost`);
  }
  return input as GeneratedStory;
}

function generatedStoryIdentity(story: GeneratedStory): string {
  // StoryGenerator returns a JSON-only object with stable field construction.
  // The generation is random, but this ID is fixed by the
  // exact resulting story rather than a clock, session, or future re-roll.
  return `generated_story_${sha256(`${GENERATED_STORY_SOURCE}\u0000${JSON.stringify(story)}`).slice(0, 24)}`;
}

/**
 * Generated source identifiers are local-template vocabulary, not world-store
 * primary keys. Bind every runtime-facing ID to this exact module so a runtime
 * dependency cannot overwrite p1, built-in clue definitions, or host rows.
 */
function generatedRuntimeId(moduleId: string, kind: string, sourceId: string): string {
  return `${moduleId}:${kind}:${sourceId}`;
}

/**
 * Pure, fail-closed conversion.  It validates all generated references before
 * returning an installable RuntimeModuleData value, so callers can perform
 * this work before the first runtime host/world write.
 */
export function generatedStoryToRuntimeModuleData(input: unknown): RuntimeModuleData {
  const story = validateGeneratedStory(input);
  nonBlank(story.title, "title");
  nonBlank(story.hook, "hook");
  if (story.scenes.length === 0) throw new Error("generated story must contain at least one scene");

  const sceneIds = story.scenes.map((scene) => scene.id);
  const sceneIdSet = new Set(sceneIds);
  if (sceneIdSet.size !== sceneIds.length || sceneIds.some((id) => id.trim().length === 0)) {
    throw new Error("generated story scene IDs must be unique non-blank text");
  }
  const entryScenes = story.scenes.filter((scene) => scene.isActive);
  if (entryScenes.length !== 1) throw new Error("generated story must declare exactly one active entry scene");
  for (const scene of story.scenes) {
    nonBlank(scene.name, `scene ${scene.id} name`);
    nonBlank(scene.description, `scene ${scene.id} description`);
    nonBlank(scene.lighting, `scene ${scene.id} lighting`);
    if (scene.dangers.some((danger) => danger.trim().length === 0)) throw new Error(`generated story scene ${scene.id} has a blank danger`);
    const exitTargets = new Set<string>();
    for (const exit of scene.exits) {
      if (!sceneIdSet.has(exit.target)) throw new Error(`generated story exit ${scene.id} references an unknown scene ${exit.target}`);
      nonBlank(exit.desc, `exit ${scene.id} -> ${exit.target}`);
      if (exit.locked) {
        throw new Error(`generated story exit ${scene.id} -> ${exit.target} is locked, but generated locks have no executable gate semantics`);
      }
      if (exitTargets.has(exit.target)) throw new Error(`generated story scene ${scene.id} duplicates exit ${exit.target}`);
      exitTargets.add(exit.target);
    }
  }

  assertExactKeys(story.displayNames, sceneIds, "displayNames");
  for (const scene of story.scenes) {
    if (story.displayNames[scene.id] !== scene.name) throw new Error(`generated story display name disagrees for ${scene.id}`);
  }
  for (const [alias, sceneId] of Object.entries(story.aliases)) {
    nonBlank(alias, "alias");
    if (!sceneIdSet.has(sceneId)) throw new Error(`generated story alias ${alias} references an unknown scene ${sceneId}`);
  }

  assertExactKeys(story.items, sceneIds, "items");
  for (const scene of story.scenes) {
    const items = story.items[scene.id];
    if (!Array.isArray(items) || !sameStrings(items, scene.items)) throw new Error(`generated story item map disagrees for ${scene.id}`);
    if (items.some((item) => item.trim().length === 0)) throw new Error(`generated story scene ${scene.id} has a blank item`);
  }

  const entityIds = story.entities.map((entity) => entity.id);
  if (new Set(entityIds).size !== entityIds.length || entityIds.some((id) => id.trim().length === 0)) {
    throw new Error("generated story entity IDs must be unique non-blank text");
  }
  for (const entity of story.entities) {
    nonBlank(entity.name, `entity ${entity.id} name`);
    nonBlank(entity.faction, `entity ${entity.id} faction`);
    if (!sceneIdSet.has(entity.scene_id) || entity.position !== entity.scene_id) {
      throw new Error(`generated story entity ${entity.id} does not have one declared scene binding`);
    }
    if (!Number.isSafeInteger(entity.hp) || !Number.isSafeInteger(entity.maxHp) || !Number.isSafeInteger(entity.ac)
      || entity.hp < 0 || entity.maxHp < entity.hp || entity.ac < 0) {
      throw new Error(`generated story entity ${entity.id} has invalid combat statistics`);
    }
    if (entity.status.some((status) => status.trim().length === 0)) throw new Error(`generated story entity ${entity.id} has a blank status`);
  }

  const clueById = new Map(story.clueTexts.map((clue) => [clue.id, clue]));
  if (clueById.size !== story.clueTexts.length) throw new Error("generated story clue IDs must be unique");
  for (const clue of story.clueTexts) {
    nonBlank(clue.id, "clue id");
    nonBlank(clue.type, `clue ${clue.id} type`);
    nonBlank(clue.category, `clue ${clue.id} category`);
    nonBlank(clue.description, `clue ${clue.id} description`);
    nonBlank(clue.coc_primary, `clue ${clue.id} primary method`);
    nonBlank(clue.coc_secondary, `clue ${clue.id} secondary method`);
    nonBlank(clue.san_cost, `clue ${clue.id} SAN cost`);
    if (!sceneIdSet.has(clue.scene)) throw new Error(`generated story clue ${clue.id} references an unknown scene ${clue.scene}`);
  }
  for (const scene of story.scenes) {
    if (new Set(scene.clues).size !== scene.clues.length) throw new Error(`generated story scene ${scene.id} repeats a clue ID`);
    for (const clueId of scene.clues) {
      const clue = clueById.get(clueId);
      if (!clue || clue.scene !== scene.id) throw new Error(`generated story scene ${scene.id} has an unbound clue ${clueId}`);
    }
  }
  for (const clue of story.clueTexts) {
    const scene = story.scenes.find((candidate) => candidate.id === clue.scene);
    if (!scene?.clues.includes(clue.id)) throw new Error(`generated story clue ${clue.id} is absent from its declared scene`);
  }

  const moduleId = generatedStoryIdentity(story);
  const sceneRuntimeIds = new Map(sceneIds.map((id) => [id, generatedRuntimeId(moduleId, "scene", id)]));
  const entityRuntimeIds = new Map(entityIds.map((id) => [id, generatedRuntimeId(moduleId, "entity", id)]));
  const clueRuntimeIds = new Map(story.clueTexts.map((clue) => [clue.id, generatedRuntimeId(moduleId, "clue", clue.id)]));
  const sceneRuntimeId = (id: string): string => {
    const resolved = sceneRuntimeIds.get(id);
    if (!resolved) throw new Error(`generated story scene ${id} disappeared during runtime ID binding`);
    return resolved;
  };
  const entityRuntimeId = (id: string): string => {
    const resolved = entityRuntimeIds.get(id);
    if (!resolved) throw new Error(`generated story entity ${id} disappeared during runtime ID binding`);
    return resolved;
  };
  const clueRuntimeId = (id: string): string => {
    const resolved = clueRuntimeIds.get(id);
    if (!resolved) throw new Error(`generated story clue ${id} disappeared during runtime ID binding`);
    return resolved;
  };
  const aliasesByScene: Record<string, string[]> = {};
  for (const scene of story.scenes) aliasesByScene[sceneRuntimeId(scene.id)] = [];
  for (const [alias, sceneId] of Object.entries(story.aliases)) {
    const values = aliasesByScene[sceneRuntimeId(sceneId)];
    if (!values) throw new Error(`generated story alias ${alias} lost its scene during conversion`);
    if (!values.includes(alias)) values.push(alias);
  }
  for (const scene of story.scenes) {
    const values = aliasesByScene[sceneRuntimeId(scene.id)]!;
    if (!values.includes(scene.name)) values.unshift(scene.name);
  }

  const module: RuntimeModuleData = {
    id: moduleId,
    title: story.title,
    version: GENERATED_STORY_RUNTIME_MODULE_VERSION,
    ruleset: "cosmic-horror",
    era: "local-rule-generated",
    summary: story.hook,
    meta: {
      author: "local rule-story generator",
      playerCount: "1-4",
      expectedDuration: "one session",
      triggerWarnings: ["horror", "local-rule-generated content"],
    },
    scenes: story.scenes.map((scene) => ({
      id: sceneRuntimeId(scene.id),
      name: scene.name,
      description: scene.description,
      lighting: scene.lighting,
      dangers: [...scene.dangers],
      clues: scene.clues.map((clueId) => {
        const clue = clueById.get(clueId);
        if (!clue) throw new Error(`generated story clue ${clueId} disappeared during conversion`);
        return {
          id: clueRuntimeId(clue.id),
          name: clue.description,
          description: clue.description,
          sourceType: clue.type,
          category: clue.category,
          findMethods: [
            { type: "skill", skillName: clue.coc_primary, difficulty: "regular", description: `Use ${clue.coc_primary}` },
            { type: "skill", skillName: clue.coc_secondary, difficulty: "regular", description: `Use ${clue.coc_secondary}` },
          ],
          revelation: clue.description,
          unlocks: [],
          found: false,
          importance: "core",
        };
      }),
      npcIds: story.entities.filter((entity) => entity.scene_id === scene.id).map((entity) => entityRuntimeId(entity.id)),
      connections: scene.exits.map((exit, index) => ({
        connectionId: generatedRuntimeId(moduleId, "connection", `${scene.id}:${index + 1}`),
        targetSceneId: sceneRuntimeId(exit.target),
        condition: exit.desc,
      })),
      aliases: [...aliasesByScene[sceneRuntimeId(scene.id)]!],
    })),
    npcs: story.entities.map((entity) => ({
      id: entityRuntimeId(entity.id),
      name: entity.name,
      role: entity.type === "monster" ? "local-rule-generated monster" : "local-rule-generated NPC",
      description: `${entity.name} is a local rule-generated ${entity.type}.`,
      personality: {
        traits: ["local-rule-generated"],
        speech: "No authored dialogue is available.",
        attitude: "neutral",
      },
      knowledge: [],
      secrets: [],
      sceneId: sceneRuntimeId(entity.scene_id),
      runtime: {
        sourceId: entityRuntimeId(entity.id),
        sourceName: entity.name,
        sceneId: sceneRuntimeId(entity.scene_id),
        type: entity.type,
        hp: entity.hp,
        maxHp: entity.maxHp,
        ac: entity.ac,
        faction: entity.faction,
        status: [...entity.status],
      },
    })),
    endings: [],
    items: story.scenes.flatMap((scene) => scene.items.map((name, index) => ({
      id: generatedRuntimeId(moduleId, "item", `${scene.id}:${index + 1}`),
      name,
      sceneId: sceneRuntimeId(scene.id),
      description: name,
      type: "loot" as const,
    }))),
    prologue: { lines: [story.hook] },
    provenance: [{
      path: "$",
      source: "local rule templates and this exact generated result",
      result: moduleId,
      reason: "Generated by local rules; this is not PDF- or document-source-exact content.",
      by: "rule",
    }],
    runtime: {
      sourceIdentity: {
        id: moduleId,
        name: story.title,
        version: GENERATED_STORY_RUNTIME_MODULE_VERSION,
        description: "local rule-generated adventure; not derived from a PDF or external source document.",
      },
      source: GENERATED_STORY_SOURCE,
      activation: { type: "manual", condition: `generated-story:${moduleId}` },
      difficulty: "medium",
      entrySceneId: sceneRuntimeId(entryScenes[0]!.id),
      introNarration: story.hook,
      sceneAliases: aliasesByScene,
      richClueSanCosts: Object.fromEntries(story.clueTexts.map((clue) => [clueRuntimeId(clue.id), clue.san_cost])),
      runtimeNpcOrder: story.entities.map((entity) => entityRuntimeId(entity.id)),
    },
  };

  // Reuse the existing install validator, rather than claiming a second
  // generated-story schema is sufficient for runtime admission.
  return validateRuntimeModuleDataForInstall(module);
}
