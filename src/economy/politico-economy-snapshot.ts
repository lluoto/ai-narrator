import type {
  Bank,
  Currency,
  DiplomaticOffer,
  EconomyEvent,
  EconomyEventType,
  Faction,
  FinancialCrisis,
  Market,
  Policy,
  ResourceDef,
  TradeRoute,
  Treaty,
} from "./types";

/** Schema version for the portable economy payload, shared by future composite snapshots. */
export const POLITICO_ECONOMY_SNAPSHOT_VERSION = 1;
export const POLITICO_ECONOMY_SNAPSHOT_MAX_ID_LENGTH = 160;
export const POLITICO_ECONOMY_SNAPSHOT_MAX_CAUSATION_IDS = 10_000;
const MAX_ID_LENGTH = POLITICO_ECONOMY_SNAPSHOT_MAX_ID_LENGTH;
const MAX_TEXT_LENGTH = 16_384;
const MAX_FACTIONS = 512;
const MAX_MEMBERS = 4_096;
const MAX_EVENTS = 200;
const MAX_COMPONENT_EVENTS = 100;
const MAX_CAUSATION_IDS = POLITICO_ECONOMY_SNAPSHOT_MAX_CAUSATION_IDS;
const MAX_NESTING = 8;

const factionTypes = ["government", "guild", "cult", "corporation", "noble_house", "clan", "school"] as const;
const stances = ["ally", "trade_pact", "neutral", "unfriendly", "hostile", "war"] as const;
const treatyTypes = ["alliance", "trade", "non_aggression", "ceasefire", "vassal", "sanction", "embargo"] as const;
const resourceCategories = ["raw_material", "food", "luxury", "magical", "military", "strategic"] as const;
const marketTrends = ["rising", "stable", "falling"] as const;
const policyCategories = ["tax", "trade", "military", "diplomatic", "economic", "domestic"] as const;
const policyOperations = ["add", "multiply", "set"] as const;
const currencyTypes = ["commodity", "credit", "fiat"] as const;
const crisisTypes = ["inflation", "deflation", "bank_run", "default", "hyperinflation", "market_crash"] as const;
const economyEventTypes = [
  "market_shift",
  "resource_discovery",
  "trade_disruption",
  "faction_stance_change",
  "policy_enacted",
  "financial_crisis",
  "tribute_collected",
] as const;
const diplomaticActions = [
  "propose_treaty",
  "break_treaty",
  "declare_war",
  "offer_peace",
  "demand_tribute",
  "send_gift",
  "insult",
  "request_aid",
] as const;

export interface SnapshotTradeMarket extends Omit<Market, "tradeRoutes"> {
  tradeRouteIds: string[];
}

export interface SnapshotRouteMarketLink {
  routeId: string;
  fromMarketId: string;
  toMarketId: string;
}

export interface SnapshotDiplomaticOffer extends DiplomaticOffer {
  id: string;
  treatyDuration?: number;
}

export interface FactionSystemSnapshot {
  diplomaticOffers: SnapshotDiplomaticOffer[];
  events: EconomyEvent[];
  round: number;
}

export interface TradeSystemSnapshot {
  resources: ResourceDef[];
  markets: SnapshotTradeMarket[];
  tradeRoutes: TradeRoute[];
  routeMarketMap: SnapshotRouteMarketLink[];
  events: EconomyEvent[];
  round: number;
  eventCounter: number;
}

export interface PolicySystemSnapshot {
  policies: Policy[];
  events: EconomyEvent[];
  round: number;
  eventCounter: number;
}

export interface FinanceSystemSnapshot {
  currencies: Currency[];
  banks: Bank[];
  activeCrises: FinancialCrisis[];
  events: EconomyEvent[];
  round: number;
  crisisCounter: number;
  eventCounter: number;
}

/** A versioned, JSON-safe representation of every mutable economy-engine field. */
export interface PoliticoEconomySnapshot {
  version: typeof POLITICO_ECONOMY_SNAPSHOT_VERSION;
  round: number;
  events: EconomyEvent[];
  consumedCausationIds: string[];
  factions: Faction[];
  factionSystem: FactionSystemSnapshot;
  trades: TradeSystemSnapshot;
  policies: PolicySystemSnapshot;
  finances: FinanceSystemSnapshot;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type FactionRelation = Faction["relations"][string];
type DiplomaticAction = DiplomaticOffer["action"];

function fail(path: string, message: string): never {
  throw new Error(`Invalid politico-economy snapshot at ${path}: ${message}`);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(path, "expected a plain object");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) fail(path, "symbol properties are not JSON-safe");
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) fail(path, `accessor property ${key} is not JSON-safe`);
    if (!descriptor.enumerable) fail(path, `non-enumerable property ${key} is not JSON-safe`);
    if (key === "__proto__") fail(path, "contains reserved key __proto__");
  }
  return value as Record<string, unknown>;
}

/** Throws unless a JSON record has exactly the declared own keys. */
function assertExactKeys(record: Record<string, unknown>, path: string, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.getOwnPropertyNames(record)) {
    if (!allowed.has(key)) fail(path, `unknown key ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) fail(path, `missing key ${key}`);
  }
}

function member(record: Record<string, unknown>, key: string, path: string): unknown {
  if (!Object.hasOwn(record, key)) fail(path, `missing key ${key}`);
  return record[key];
}

function stringAt(value: unknown, path: string, maxLength = MAX_TEXT_LENGTH, allowEmpty = true): string {
  if (typeof value !== "string" || value.length > maxLength || (!allowEmpty && value.length === 0)) {
    fail(path, "expected a bounded string");
  }
  return value;
}

function idAt(value: unknown, path: string): string {
  return stringAt(value, path, MAX_ID_LENGTH, false);
}

function finiteNumberAt(value: unknown, path: string, min?: number, max?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a finite number");
  if (min != null && value < min) fail(path, `must be >= ${min}`);
  if (max != null && value > max) fail(path, `must be <= ${max}`);
  return value;
}

function safeIntegerAt(value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(path, `expected a safe integer between ${min} and ${max}`);
  }
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "expected a boolean");
  return value;
}

function enumAt<T extends readonly string[]>(value: unknown, path: string, values: T): T[number] {
  if (typeof value !== "string" || !values.includes(value)) fail(path, `expected one of ${values.join(", ")}`);
  return value as T[number];
}

function arrayAt(value: unknown, path: string, maxLength: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maxLength) {
    fail(path, `expected an array of at most ${maxLength} members`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) fail(path, "symbol properties are not JSON-safe");
  const ownNames = Object.getOwnPropertyNames(value);
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor) fail(path, "sparse array is not JSON-safe");
    if (!("value" in descriptor)) fail(path, `accessor property ${index} is not JSON-safe`);
    if (!descriptor.enumerable) fail(path, `non-enumerable property ${index} is not JSON-safe`);
  }
  if (ownNames.length !== value.length + 1) {
    const extra = ownNames.find(key => key !== "length" && !/^0$|^[1-9]\d*$/.test(key));
    fail(path, `unexpected array property ${extra ?? "index"}`);
  }
  return value;
}

function uniqueIds(values: readonly { id: string }[], path: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) fail(path, `duplicate id ${value.id}`);
    ids.add(value.id);
  }
}

function assertCounterCoversGeneratedIds(counter: number, path: string, ids: readonly string[], pattern: RegExp): void {
  let highest = 0;
  for (const id of ids) {
    const match = pattern.exec(id);
    if (!match) continue;
    const generated = Number(match[1]);
    if (Number.isSafeInteger(generated)) highest = Math.max(highest, generated);
  }
  if (counter < highest) fail(path, `must be at least ${highest} to avoid reusing a persisted identifier`);
}

function stringArray(value: unknown, path: string, maxLength = MAX_MEMBERS, unique = false): string[] {
  const result = arrayAt(value, path, maxLength).map((entry, index) => idAt(entry, `${path}[${index}]`));
  if (unique && new Set(result).size !== result.length) fail(path, "contains duplicate members");
  return result;
}

function jsonAt(value: unknown, path: string, depth = 0): JsonValue {
  if (depth > MAX_NESTING) fail(path, "exceeds maximum nesting depth");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return stringAt(value, path);
  if (typeof value === "number") return finiteNumberAt(value, path);
  if (Array.isArray(value)) return arrayAt(value, path, MAX_MEMBERS).map((entry, index) => jsonAt(entry, `${path}[${index}]`, depth + 1));

  const record = objectAt(value, path);
  const entries = Object.entries(record);
  if (entries.length > MAX_MEMBERS) fail(path, `has more than ${MAX_MEMBERS} keys`);
  const result: { [key: string]: JsonValue } = {};
  for (const [key, entry] of entries) {
    result[stringAt(key, `${path}.{key}`, MAX_ID_LENGTH, false)] = jsonAt(entry, `${path}.${key}`, depth + 1);
  }
  return result;
}

function eventAt(value: unknown, path: string, requireCausationId = false): EconomyEvent {
  const record = objectAt(value, path);
  assertExactKeys(record, path, ["id", "type", "round", "description", "affectedFactions"], ["data", "causationId"]);
  if (requireCausationId && !Object.hasOwn(record, "causationId")) fail(path, "missing causationId");

  const result: EconomyEvent = {
    id: idAt(member(record, "id", path), `${path}.id`),
    type: enumAt(member(record, "type", path), `${path}.type`, economyEventTypes) as EconomyEventType,
    round: safeIntegerAt(member(record, "round", path), `${path}.round`),
    description: stringAt(member(record, "description", path), `${path}.description`),
    affectedFactions: stringArray(member(record, "affectedFactions", path), `${path}.affectedFactions`, MAX_MEMBERS),
  };
  if (Object.hasOwn(record, "data")) {
    const data = jsonAt(record.data, `${path}.data`);
    if (data === null || Array.isArray(data) || typeof data !== "object") fail(`${path}.data`, "expected an object");
    result.data = data;
  }
  if (Object.hasOwn(record, "causationId")) result.causationId = idAt(record.causationId, `${path}.causationId`);
  return result;
}

function eventsAt(value: unknown, path: string, maxLength: number, requireCausationId = false): EconomyEvent[] {
  const events = arrayAt(value, path, maxLength).map((entry, index) => eventAt(entry, `${path}[${index}]`, requireCausationId));
  uniqueIds(events, path);
  return events;
}

function treatyAt(value: unknown, path: string): Treaty {
  const record = objectAt(value, path);
  assertExactKeys(record, path, ["id", "type", "parties", "terms", "signedAtRound", "active"], ["duration"]);
  const treaty: Treaty = {
    id: idAt(member(record, "id", path), `${path}.id`),
    type: enumAt(member(record, "type", path), `${path}.type`, treatyTypes),
    parties: stringArray(member(record, "parties", path), `${path}.parties`, 2, true),
    terms: stringAt(member(record, "terms", path), `${path}.terms`),
    signedAtRound: safeIntegerAt(member(record, "signedAtRound", path), `${path}.signedAtRound`),
    active: booleanAt(member(record, "active", path), `${path}.active`),
  };
  if (treaty.parties.length !== 2) fail(`${path}.parties`, "must contain exactly two factions");
  if (Object.hasOwn(record, "duration")) treaty.duration = safeIntegerAt(record.duration, `${path}.duration`, 1);
  return treaty;
}

function factionRelationAt(value: unknown, path: string): FactionRelation {
  const record = objectAt(value, path);
  assertExactKeys(record, path, ["targetId", "stance", "score", "treaties", "tradeVolume", "lastInteractionRound"]);
  const treaties = arrayAt(member(record, "treaties", path), `${path}.treaties`, MAX_MEMBERS)
    .map((entry, index) => treatyAt(entry, `${path}.treaties[${index}]`));
  uniqueIds(treaties, `${path}.treaties`);
  return {
    targetId: idAt(member(record, "targetId", path), `${path}.targetId`),
    stance: enumAt(member(record, "stance", path), `${path}.stance`, stances),
    score: finiteNumberAt(member(record, "score", path), `${path}.score`, -100, 100),
    treaties,
    tradeVolume: finiteNumberAt(member(record, "tradeVolume", path), `${path}.tradeVolume`, 0),
    lastInteractionRound: safeIntegerAt(member(record, "lastInteractionRound", path), `${path}.lastInteractionRound`),
  };
}

function numericRecordAt(value: unknown, path: string, min = 0): Record<string, number> {
  const record = objectAt(value, path);
  const entries = Object.entries(record);
  if (entries.length > MAX_MEMBERS) fail(path, `has more than ${MAX_MEMBERS} keys`);
  const result: Record<string, number> = {};
  for (const [key, entry] of entries) {
    result[idAt(key, `${path}.{key}`)] = finiteNumberAt(entry, `${path}.${key}`, min);
  }
  return result;
}

function factionAt(value: unknown, path: string): Faction {
  const record = objectAt(value, path);
  assertExactKeys(
    record,
    path,
    ["id", "name", "type", "territory", "resources", "treasury", "stability", "militaryPower", "economicPower", "relations", "activePolicies", "createdAtRound"],
    ["leaderName", "capitalName"],
  );
  const relationsRecord = objectAt(member(record, "relations", path), `${path}.relations`);
  if (Object.keys(relationsRecord).length > MAX_FACTIONS) fail(`${path}.relations`, "has too many members");
  const relations: Faction["relations"] = {};
  for (const [targetId, relation] of Object.entries(relationsRecord)) {
    relations[idAt(targetId, `${path}.relations.{key}`)] = factionRelationAt(relation, `${path}.relations.${targetId}`);
  }
  const faction: Faction = {
    id: idAt(member(record, "id", path), `${path}.id`),
    name: stringAt(member(record, "name", path), `${path}.name`),
    type: enumAt(member(record, "type", path), `${path}.type`, factionTypes),
    territory: stringArray(member(record, "territory", path), `${path}.territory`),
    resources: numericRecordAt(member(record, "resources", path), `${path}.resources`),
    treasury: finiteNumberAt(member(record, "treasury", path), `${path}.treasury`, 0),
    stability: finiteNumberAt(member(record, "stability", path), `${path}.stability`, 0, 100),
    militaryPower: finiteNumberAt(member(record, "militaryPower", path), `${path}.militaryPower`, 0),
    economicPower: finiteNumberAt(member(record, "economicPower", path), `${path}.economicPower`, 0),
    relations,
    activePolicies: stringArray(member(record, "activePolicies", path), `${path}.activePolicies`, MAX_MEMBERS, true),
    createdAtRound: safeIntegerAt(member(record, "createdAtRound", path), `${path}.createdAtRound`),
  };
  if (Object.hasOwn(record, "leaderName")) faction.leaderName = stringAt(record.leaderName, `${path}.leaderName`);
  if (Object.hasOwn(record, "capitalName")) faction.capitalName = stringAt(record.capitalName, `${path}.capitalName`);
  return faction;
}

function diplomaticOfferAt(value: unknown, path: string): SnapshotDiplomaticOffer {
  const record = objectAt(value, path);
  assertExactKeys(record, path, ["id", "action", "fromFactionId", "toFactionId", "expiresAtRound"], ["treatyType", "terms", "giftAmount", "resourceId", "resourceAmount", "treatyDuration"]);
  const offer: SnapshotDiplomaticOffer = {
    id: idAt(member(record, "id", path), `${path}.id`),
    action: enumAt(member(record, "action", path), `${path}.action`, diplomaticActions) as DiplomaticAction,
    fromFactionId: idAt(member(record, "fromFactionId", path), `${path}.fromFactionId`),
    toFactionId: idAt(member(record, "toFactionId", path), `${path}.toFactionId`),
    expiresAtRound: safeIntegerAt(member(record, "expiresAtRound", path), `${path}.expiresAtRound`),
  };
  if (Object.hasOwn(record, "treatyType")) offer.treatyType = enumAt(record.treatyType, `${path}.treatyType`, treatyTypes);
  if (Object.hasOwn(record, "terms")) offer.terms = stringAt(record.terms, `${path}.terms`);
  if (Object.hasOwn(record, "giftAmount")) offer.giftAmount = finiteNumberAt(record.giftAmount, `${path}.giftAmount`, 0);
  if (Object.hasOwn(record, "resourceId")) offer.resourceId = idAt(record.resourceId, `${path}.resourceId`);
  if (Object.hasOwn(record, "resourceAmount")) offer.resourceAmount = finiteNumberAt(record.resourceAmount, `${path}.resourceAmount`, 0);
  if (Object.hasOwn(record, "treatyDuration")) offer.treatyDuration = safeIntegerAt(record.treatyDuration, `${path}.treatyDuration`, 1);
  return offer;
}

function resourceAt(value: unknown, path: string): ResourceDef {
  const record = objectAt(value, path);
  assertExactKeys(record, path, ["id", "name", "category", "basePrice", "description", "isFinite"]);
  return {
    id: idAt(member(record, "id", path), `${path}.id`),
    name: stringAt(member(record, "name", path), `${path}.name`),
    category: enumAt(member(record, "category", path), `${path}.category`, resourceCategories),
    basePrice: finiteNumberAt(member(record, "basePrice", path), `${path}.basePrice`, 0),
    description: stringAt(member(record, "description", path), `${path}.description`),
    isFinite: booleanAt(member(record, "isFinite", path), `${path}.isFinite`),
  };
}

function marketAt(value: unknown, path: string): SnapshotTradeMarket {
  const record = objectAt(value, path);
  assertExactKeys(record, path, ["id", "name", "location", "controlledBy", "entries", "tradeRouteIds", "taxRate", "lastUpdateRound"]);
  const entryRecord = objectAt(member(record, "entries", path), `${path}.entries`);
  if (Object.keys(entryRecord).length > MAX_MEMBERS) fail(`${path}.entries`, "has too many members");
  const entries: Market["entries"] = {};
  for (const [resourceId, value] of Object.entries(entryRecord)) {
    const entryPath = `${path}.entries.${resourceId}`;
    const entry = objectAt(value, entryPath);
    assertExactKeys(entry, entryPath, ["resourceId", "price", "supply", "demand", "trend", "lastUpdatedRound"]);
    const id = idAt(resourceId, `${entryPath}.{key}`);
    entries[id] = {
      resourceId: idAt(member(entry, "resourceId", entryPath), `${entryPath}.resourceId`),
      price: finiteNumberAt(member(entry, "price", entryPath), `${entryPath}.price`, 0),
      supply: finiteNumberAt(member(entry, "supply", entryPath), `${entryPath}.supply`, 0),
      demand: finiteNumberAt(member(entry, "demand", entryPath), `${entryPath}.demand`, 0),
      trend: enumAt(member(entry, "trend", entryPath), `${entryPath}.trend`, marketTrends),
      lastUpdatedRound: safeIntegerAt(member(entry, "lastUpdatedRound", entryPath), `${entryPath}.lastUpdatedRound`),
    };
    if (entries[id].resourceId !== id) fail(entryPath, "resourceId must match its entry key");
  }
  return {
    id: idAt(member(record, "id", path), `${path}.id`),
    name: stringAt(member(record, "name", path), `${path}.name`),
    location: stringAt(member(record, "location", path), `${path}.location`),
    controlledBy: idAt(member(record, "controlledBy", path), `${path}.controlledBy`),
    entries,
    tradeRouteIds: stringArray(member(record, "tradeRouteIds", path), `${path}.tradeRouteIds`, MAX_MEMBERS, true),
    taxRate: finiteNumberAt(member(record, "taxRate", path), `${path}.taxRate`, 0, 1),
    lastUpdateRound: safeIntegerAt(member(record, "lastUpdateRound", path), `${path}.lastUpdateRound`),
  };
}

function tradeRouteAt(value: unknown, path: string): TradeRoute {
  const record = objectAt(value, path);
  assertExactKeys(record, path, ["id", "fromFactionId", "toFactionId", "resourceId", "volume", "price", "active", "establishedRound"]);
  return {
    id: idAt(member(record, "id", path), `${path}.id`),
    fromFactionId: idAt(member(record, "fromFactionId", path), `${path}.fromFactionId`),
    toFactionId: idAt(member(record, "toFactionId", path), `${path}.toFactionId`),
    resourceId: idAt(member(record, "resourceId", path), `${path}.resourceId`),
    volume: finiteNumberAt(member(record, "volume", path), `${path}.volume`, 0),
    price: finiteNumberAt(member(record, "price", path), `${path}.price`, 0),
    active: booleanAt(member(record, "active", path), `${path}.active`),
    establishedRound: safeIntegerAt(member(record, "establishedRound", path), `${path}.establishedRound`),
  };
}

function routeMarketLinkAt(value: unknown, path: string): SnapshotRouteMarketLink {
  const record = objectAt(value, path);
  assertExactKeys(record, path, ["routeId", "fromMarketId", "toMarketId"]);
  return {
    routeId: idAt(member(record, "routeId", path), `${path}.routeId`),
    fromMarketId: idAt(member(record, "fromMarketId", path), `${path}.fromMarketId`),
    toMarketId: idAt(member(record, "toMarketId", path), `${path}.toMarketId`),
  };
}

function policyAt(value: unknown, path: string): Policy {
  const record = objectAt(value, path);
  assertExactKeys(record, path, ["id", "name", "description", "factionId", "category", "effects", "active", "enactedAtRound", "cost", "cooldown"]);
  const effects = arrayAt(member(record, "effects", path), `${path}.effects`, MAX_MEMBERS).map((value, index) => {
    const effectPath = `${path}.effects[${index}]`;
    const effect = objectAt(value, effectPath);
    assertExactKeys(effect, effectPath, ["target", "operation", "value", "description"]);
    return {
      target: stringAt(member(effect, "target", effectPath), `${effectPath}.target`, MAX_ID_LENGTH, false),
      operation: enumAt(member(effect, "operation", effectPath), `${effectPath}.operation`, policyOperations),
      value: finiteNumberAt(member(effect, "value", effectPath), `${effectPath}.value`),
      description: stringAt(member(effect, "description", effectPath), `${effectPath}.description`),
    };
  });
  return {
    id: idAt(member(record, "id", path), `${path}.id`),
    name: stringAt(member(record, "name", path), `${path}.name`),
    description: stringAt(member(record, "description", path), `${path}.description`),
    factionId: idAt(member(record, "factionId", path), `${path}.factionId`),
    category: enumAt(member(record, "category", path), `${path}.category`, policyCategories),
    effects,
    active: booleanAt(member(record, "active", path), `${path}.active`),
    enactedAtRound: safeIntegerAt(member(record, "enactedAtRound", path), `${path}.enactedAtRound`),
    cost: finiteNumberAt(member(record, "cost", path), `${path}.cost`, 0),
    cooldown: safeIntegerAt(member(record, "cooldown", path), `${path}.cooldown`),
  };
}

function currencyAt(value: unknown, path: string): Currency {
  const record = objectAt(value, path);
  assertExactKeys(record, path, ["id", "name", "type", "issuer", "exchangeRate", "supply", "stability"]);
  const exchangeRate = numericRecordAt(member(record, "exchangeRate", path), `${path}.exchangeRate`, Number.MIN_VALUE);
  return {
    id: idAt(member(record, "id", path), `${path}.id`),
    name: stringAt(member(record, "name", path), `${path}.name`),
    type: enumAt(member(record, "type", path), `${path}.type`, currencyTypes),
    issuer: stringAt(member(record, "issuer", path), `${path}.issuer`),
    exchangeRate,
    supply: finiteNumberAt(member(record, "supply", path), `${path}.supply`, 0),
    stability: finiteNumberAt(member(record, "stability", path), `${path}.stability`, 0, 100),
  };
}

function bankAt(value: unknown, path: string): Bank {
  const record = objectAt(value, path);
  assertExactKeys(record, path, ["id", "name", "location", "factionId", "reserves", "loans", "stability"]);
  const loans = arrayAt(member(record, "loans", path), `${path}.loans`, MAX_MEMBERS).map((value, index) => {
    const loanPath = `${path}.loans[${index}]`;
    const loan = objectAt(value, loanPath);
    assertExactKeys(loan, loanPath, ["id", "borrower", "amount", "currencyId", "interestRate", "remainingRounds", "collateral", "defaulted"]);
    return {
      id: idAt(member(loan, "id", loanPath), `${loanPath}.id`),
      borrower: idAt(member(loan, "borrower", loanPath), `${loanPath}.borrower`),
      amount: finiteNumberAt(member(loan, "amount", loanPath), `${loanPath}.amount`, 0),
      currencyId: idAt(member(loan, "currencyId", loanPath), `${loanPath}.currencyId`),
      interestRate: finiteNumberAt(member(loan, "interestRate", loanPath), `${loanPath}.interestRate`, 0),
      remainingRounds: safeIntegerAt(member(loan, "remainingRounds", loanPath), `${loanPath}.remainingRounds`, -Number.MAX_SAFE_INTEGER),
      collateral: stringAt(member(loan, "collateral", loanPath), `${loanPath}.collateral`),
      defaulted: booleanAt(member(loan, "defaulted", loanPath), `${loanPath}.defaulted`),
    };
  });
  uniqueIds(loans, `${path}.loans`);
  return {
    id: idAt(member(record, "id", path), `${path}.id`),
    name: stringAt(member(record, "name", path), `${path}.name`),
    location: stringAt(member(record, "location", path), `${path}.location`),
    factionId: idAt(member(record, "factionId", path), `${path}.factionId`),
    reserves: numericRecordAt(member(record, "reserves", path), `${path}.reserves`),
    loans,
    stability: finiteNumberAt(member(record, "stability", path), `${path}.stability`, 0, 100),
  };
}

function crisisAt(value: unknown, path: string): FinancialCrisis {
  const record = objectAt(value, path);
  assertExactKeys(record, path, ["id", "type", "severity", "name", "description", "affectedFactionIds", "startedAtRound", "resolved"], ["resolvedAtRound"]);
  const crisis: FinancialCrisis = {
    id: idAt(member(record, "id", path), `${path}.id`),
    type: enumAt(member(record, "type", path), `${path}.type`, crisisTypes),
    severity: safeIntegerAt(member(record, "severity", path), `${path}.severity`, 1, 10),
    name: stringAt(member(record, "name", path), `${path}.name`),
    description: stringAt(member(record, "description", path), `${path}.description`),
    affectedFactionIds: stringArray(member(record, "affectedFactionIds", path), `${path}.affectedFactionIds`, MAX_MEMBERS, true),
    startedAtRound: safeIntegerAt(member(record, "startedAtRound", path), `${path}.startedAtRound`),
    resolved: booleanAt(member(record, "resolved", path), `${path}.resolved`),
  };
  if (Object.hasOwn(record, "resolvedAtRound")) crisis.resolvedAtRound = safeIntegerAt(record.resolvedAtRound, `${path}.resolvedAtRound`);
  if (!crisis.resolved && crisis.resolvedAtRound != null) fail(path, "unresolved crisis cannot have resolvedAtRound");
  if (crisis.resolved && crisis.resolvedAtRound == null) fail(path, "resolved crisis must have resolvedAtRound");
  return crisis;
}

function factionSystemAt(value: unknown, path: string): FactionSystemSnapshot {
  const record = objectAt(value, path);
  assertExactKeys(record, path, ["diplomaticOffers", "events", "round"]);
  const offers = arrayAt(member(record, "diplomaticOffers", path), `${path}.diplomaticOffers`, MAX_MEMBERS)
    .map((entry, index) => diplomaticOfferAt(entry, `${path}.diplomaticOffers[${index}]`));
  uniqueIds(offers, `${path}.diplomaticOffers`);
  return {
    diplomaticOffers: offers,
    events: eventsAt(member(record, "events", path), `${path}.events`, MAX_COMPONENT_EVENTS),
    round: safeIntegerAt(member(record, "round", path), `${path}.round`),
  };
}

function tradeSystemAt(value: unknown, path: string): TradeSystemSnapshot {
  const record = objectAt(value, path);
  assertExactKeys(record, path, ["resources", "markets", "tradeRoutes", "routeMarketMap", "events", "round", "eventCounter"]);
  const resources = arrayAt(member(record, "resources", path), `${path}.resources`, MAX_MEMBERS)
    .map((entry, index) => resourceAt(entry, `${path}.resources[${index}]`));
  const markets = arrayAt(member(record, "markets", path), `${path}.markets`, MAX_MEMBERS)
    .map((entry, index) => marketAt(entry, `${path}.markets[${index}]`));
  const tradeRoutes = arrayAt(member(record, "tradeRoutes", path), `${path}.tradeRoutes`, MAX_MEMBERS)
    .map((entry, index) => tradeRouteAt(entry, `${path}.tradeRoutes[${index}]`));
  const routeMarketMap = arrayAt(member(record, "routeMarketMap", path), `${path}.routeMarketMap`, MAX_MEMBERS)
    .map((entry, index) => routeMarketLinkAt(entry, `${path}.routeMarketMap[${index}]`));
  uniqueIds(resources, `${path}.resources`);
  uniqueIds(markets, `${path}.markets`);
  uniqueIds(tradeRoutes, `${path}.tradeRoutes`);
  uniqueIds(routeMarketMap.map(link => ({ id: link.routeId })), `${path}.routeMarketMap`);
  const events = eventsAt(member(record, "events", path), `${path}.events`, MAX_COMPONENT_EVENTS);
  const eventCounter = safeIntegerAt(member(record, "eventCounter", path), `${path}.eventCounter`);
  assertCounterCoversGeneratedIds(eventCounter, `${path}.eventCounter`, events.map(event => event.id), /^evt_(?:\d+_)?(\d+)$/);
  return {
    resources,
    markets,
    tradeRoutes,
    routeMarketMap,
    events,
    round: safeIntegerAt(member(record, "round", path), `${path}.round`),
    eventCounter,
  };
}

function policySystemAt(value: unknown, path: string): PolicySystemSnapshot {
  const record = objectAt(value, path);
  assertExactKeys(record, path, ["policies", "events", "round", "eventCounter"]);
  const policies = arrayAt(member(record, "policies", path), `${path}.policies`, MAX_MEMBERS)
    .map((entry, index) => policyAt(entry, `${path}.policies[${index}]`));
  uniqueIds(policies, `${path}.policies`);
  const events = eventsAt(member(record, "events", path), `${path}.events`, MAX_COMPONENT_EVENTS);
  const eventCounter = safeIntegerAt(member(record, "eventCounter", path), `${path}.eventCounter`);
  assertCounterCoversGeneratedIds(
    eventCounter,
    `${path}.eventCounter`,
    [...policies, ...events].map(record => record.id),
    /^(?:policy|event)_\d+_[a-z0-9]+_(\d+)$/,
  );
  return {
    policies,
    events,
    round: safeIntegerAt(member(record, "round", path), `${path}.round`),
    eventCounter,
  };
}

function financeSystemAt(value: unknown, path: string): FinanceSystemSnapshot {
  const record = objectAt(value, path);
  assertExactKeys(record, path, ["currencies", "banks", "activeCrises", "events", "round", "crisisCounter", "eventCounter"]);
  const currencies = arrayAt(member(record, "currencies", path), `${path}.currencies`, MAX_MEMBERS)
    .map((entry, index) => currencyAt(entry, `${path}.currencies[${index}]`));
  const banks = arrayAt(member(record, "banks", path), `${path}.banks`, MAX_MEMBERS)
    .map((entry, index) => bankAt(entry, `${path}.banks[${index}]`));
  const activeCrises = arrayAt(member(record, "activeCrises", path), `${path}.activeCrises`, MAX_MEMBERS)
    .map((entry, index) => crisisAt(entry, `${path}.activeCrises[${index}]`));
  uniqueIds(currencies, `${path}.currencies`);
  uniqueIds(banks, `${path}.banks`);
  uniqueIds(activeCrises, `${path}.activeCrises`);
  const loanIds = new Set<string>();
  for (const bank of banks) {
    for (const loan of bank.loans) {
      if (loanIds.has(loan.id)) fail(`${path}.banks`, `duplicate loan id ${loan.id}`);
      loanIds.add(loan.id);
    }
  }
  const events = eventsAt(member(record, "events", path), `${path}.events`, MAX_COMPONENT_EVENTS);
  const crisisCounter = safeIntegerAt(member(record, "crisisCounter", path), `${path}.crisisCounter`);
  const eventCounter = safeIntegerAt(member(record, "eventCounter", path), `${path}.eventCounter`);
  assertCounterCoversGeneratedIds(crisisCounter, `${path}.crisisCounter`, activeCrises.map(crisis => crisis.id), /^crisis_(\d+)$/);
  assertCounterCoversGeneratedIds(eventCounter, `${path}.eventCounter`, events.map(event => event.id), /^evt_(\d+)$/);
  return {
    currencies,
    banks,
    activeCrises,
    events,
    round: safeIntegerAt(member(record, "round", path), `${path}.round`),
    crisisCounter,
    eventCounter,
  };
}

function requireKnownFaction(id: string, factions: ReadonlySet<string>, path: string): void {
  if (!factions.has(id)) fail(path, `unknown faction reference ${id}`);
}

function validateEvents(events: readonly EconomyEvent[], factions: ReadonlySet<string>, round: number, path: string, requireCausationId = false): void {
  for (const [index, event] of events.entries()) {
    if (event.round > round) fail(`${path}[${index}].round`, "cannot be in the future");
    if (requireCausationId && event.causationId == null) fail(`${path}[${index}].causationId`, "is required");
    for (const factionId of event.affectedFactions) requireKnownFaction(factionId, factions, `${path}[${index}].affectedFactions`);
  }
}

function validateCrossReferences(snapshot: PoliticoEconomySnapshot): void {
  const factionIds = new Set(snapshot.factions.map(faction => faction.id));
  const factionById = new Map(snapshot.factions.map(faction => [faction.id, faction]));

  if (snapshot.factionSystem.round !== snapshot.round || snapshot.trades.round !== snapshot.round
    || snapshot.policies.round !== snapshot.round || snapshot.finances.round !== snapshot.round) {
    fail("round", "engine and all subsystem rounds must agree");
  }

  for (const faction of snapshot.factions) {
    if (faction.createdAtRound > snapshot.round) fail(`factions.${faction.id}.createdAtRound`, "cannot be in the future");
    for (const policyId of faction.activePolicies) {
      const policy = snapshot.policies.policies.find(candidate => candidate.id === policyId);
      if (!policy) fail(`factions.${faction.id}.activePolicies`, `unknown policy reference ${policyId}`);
      if (policy.factionId !== faction.id) fail(`factions.${faction.id}.activePolicies`, `policy ${policyId} belongs to another faction`);
    }
    for (const [targetId, relation] of Object.entries(faction.relations)) {
      if (targetId !== relation.targetId) fail(`factions.${faction.id}.relations.${targetId}`, "targetId must match relation key");
      requireKnownFaction(targetId, factionIds, `factions.${faction.id}.relations.${targetId}`);
      if (relation.lastInteractionRound > snapshot.round) fail(`factions.${faction.id}.relations.${targetId}.lastInteractionRound`, "cannot be in the future");
      const reciprocal = factionById.get(targetId)?.relations[faction.id];
      if (!reciprocal || reciprocal.score !== relation.score || reciprocal.stance !== relation.stance || reciprocal.tradeVolume !== relation.tradeVolume) {
        fail(`factions.${faction.id}.relations.${targetId}`, "must have an equivalent reciprocal relation");
      }
      for (const treaty of relation.treaties) {
        if (!treaty.parties.includes(faction.id) || !treaty.parties.includes(targetId)) {
          fail(`factions.${faction.id}.relations.${targetId}.treaties.${treaty.id}`, "must name both related factions");
        }
        if (treaty.signedAtRound > snapshot.round) fail(`factions.${faction.id}.relations.${targetId}.treaties.${treaty.id}.signedAtRound`, "cannot be in the future");
        const counterpart = reciprocal.treaties.find(candidate => candidate.id === treaty.id);
        if (!counterpart || JSON.stringify(counterpart) !== JSON.stringify(treaty)) {
          fail(`factions.${faction.id}.relations.${targetId}.treaties.${treaty.id}`, "must match its reciprocal treaty");
        }
      }
    }
  }

  for (const offer of snapshot.factionSystem.diplomaticOffers) {
    requireKnownFaction(offer.fromFactionId, factionIds, `factionSystem.diplomaticOffers.${offer.id}.fromFactionId`);
    requireKnownFaction(offer.toFactionId, factionIds, `factionSystem.diplomaticOffers.${offer.id}.toFactionId`);
    if (offer.expiresAtRound < snapshot.round) fail(`factionSystem.diplomaticOffers.${offer.id}.expiresAtRound`, "cannot already be expired");
  }
  for (const policy of snapshot.policies.policies) {
    requireKnownFaction(policy.factionId, factionIds, `policies.policies.${policy.id}.factionId`);
    if (policy.enactedAtRound > snapshot.round) fail(`policies.policies.${policy.id}.enactedAtRound`, "cannot be in the future");
  }

  const marketById = new Map(snapshot.trades.markets.map(market => [market.id, market]));
  const routeById = new Map(snapshot.trades.tradeRoutes.map(route => [route.id, route]));
  const linkByRouteId = new Map(snapshot.trades.routeMarketMap.map(link => [link.routeId, link]));
  for (const market of snapshot.trades.markets) {
    requireKnownFaction(market.controlledBy, factionIds, `trades.markets.${market.id}.controlledBy`);
    if (market.lastUpdateRound > snapshot.round) fail(`trades.markets.${market.id}.lastUpdateRound`, "cannot be in the future");
    for (const entry of Object.values(market.entries)) {
      if (entry.lastUpdatedRound > snapshot.round) fail(`trades.markets.${market.id}.entries.${entry.resourceId}.lastUpdatedRound`, "cannot be in the future");
    }
    for (const routeId of market.tradeRouteIds) {
      const route = routeById.get(routeId);
      const link = linkByRouteId.get(routeId);
      if (!route || !link || !route.active || (link.fromMarketId !== market.id && link.toMarketId !== market.id)) {
        fail(`trades.markets.${market.id}.tradeRouteIds`, `invalid route reference ${routeId}`);
      }
    }
  }
  for (const route of snapshot.trades.tradeRoutes) {
    requireKnownFaction(route.fromFactionId, factionIds, `trades.tradeRoutes.${route.id}.fromFactionId`);
    requireKnownFaction(route.toFactionId, factionIds, `trades.tradeRoutes.${route.id}.toFactionId`);
    if (route.establishedRound > snapshot.round) fail(`trades.tradeRoutes.${route.id}.establishedRound`, "cannot be in the future");
    const link = linkByRouteId.get(route.id);
    if (!route.active) {
      if (link) fail(`trades.routeMarketMap.${route.id}`, "inactive routes cannot have a market link");
      continue;
    }
    if (!link) fail(`trades.tradeRoutes.${route.id}`, "active routes must have a market link");
    const fromMarket = marketById.get(link.fromMarketId);
    const toMarket = marketById.get(link.toMarketId);
    if (!fromMarket || !toMarket || !fromMarket.tradeRouteIds.includes(route.id) || !toMarket.tradeRouteIds.includes(route.id)) {
      fail(`trades.routeMarketMap.${route.id}`, "must reference both route markets");
    }
    if (fromMarket.controlledBy !== route.fromFactionId || toMarket.controlledBy !== route.toFactionId
      || !fromMarket.entries[route.resourceId] || !toMarket.entries[route.resourceId]) {
      fail(`trades.tradeRoutes.${route.id}`, "does not match its markets");
    }
  }
  for (const link of snapshot.trades.routeMarketMap) {
    if (!routeById.has(link.routeId) || !marketById.has(link.fromMarketId) || !marketById.has(link.toMarketId)) {
      fail(`trades.routeMarketMap.${link.routeId}`, "contains an unknown reference");
    }
  }

  const currencyIds = new Set(snapshot.finances.currencies.map(currency => currency.id));
  for (const currency of snapshot.finances.currencies) {
    for (const [currencyId, rate] of Object.entries(currency.exchangeRate)) {
      if (!currencyIds.has(currencyId) || currencyId === currency.id) fail(`finances.currencies.${currency.id}.exchangeRate.${currencyId}`, "references an invalid currency");
      const inverse = snapshot.finances.currencies.find(candidate => candidate.id === currencyId)?.exchangeRate[currency.id];
      if (inverse == null || Math.abs(rate * inverse - 1) > Number.EPSILON * 16) {
        fail(`finances.currencies.${currency.id}.exchangeRate.${currencyId}`, "is missing its reciprocal exchange rate");
      }
    }
  }
  for (const bank of snapshot.finances.banks) {
    requireKnownFaction(bank.factionId, factionIds, `finances.banks.${bank.id}.factionId`);
    for (const currencyId of Object.keys(bank.reserves)) {
      if (!currencyIds.has(currencyId)) fail(`finances.banks.${bank.id}.reserves.${currencyId}`, "references an unknown currency");
    }
    for (const loan of bank.loans) {
      requireKnownFaction(loan.borrower, factionIds, `finances.banks.${bank.id}.loans.${loan.id}.borrower`);
      if (!currencyIds.has(loan.currencyId)) fail(`finances.banks.${bank.id}.loans.${loan.id}.currencyId`, "references an unknown currency");
    }
  }
  for (const crisis of snapshot.finances.activeCrises) {
    if (crisis.startedAtRound > snapshot.round || (crisis.resolvedAtRound != null && crisis.resolvedAtRound > snapshot.round)) {
      fail(`finances.activeCrises.${crisis.id}`, "cannot be in the future");
    }
    for (const factionId of crisis.affectedFactionIds) requireKnownFaction(factionId, factionIds, `finances.activeCrises.${crisis.id}.affectedFactionIds`);
  }

  validateEvents(snapshot.events, factionIds, snapshot.round, "events", true);
  validateEvents(snapshot.factionSystem.events, factionIds, snapshot.round, "factionSystem.events");
  validateEvents(snapshot.trades.events, factionIds, snapshot.round, "trades.events");
  validateEvents(snapshot.policies.events, factionIds, snapshot.round, "policies.events");
  validateEvents(snapshot.finances.events, factionIds, snapshot.round, "finances.events");
  const consumed = new Set(snapshot.consumedCausationIds);
  for (const event of snapshot.events) {
    if (!event.causationId || !consumed.has(event.causationId)) fail(`events.${event.id}.causationId`, "must be listed as consumed");
  }
}

/**
 * The sole untrusted-input boundary for economy persistence. It creates a new
 * JSON-safe object before any engine state is replaced.
 */
export function validatePoliticoEconomySnapshot(value: unknown): PoliticoEconomySnapshot {
  const record = objectAt(value, "snapshot");
  assertExactKeys(record, "snapshot", ["version", "round", "events", "consumedCausationIds", "factions", "factionSystem", "trades", "policies", "finances"]);
  if (safeIntegerAt(member(record, "version", "snapshot"), "snapshot.version", POLITICO_ECONOMY_SNAPSHOT_VERSION, POLITICO_ECONOMY_SNAPSHOT_VERSION) !== POLITICO_ECONOMY_SNAPSHOT_VERSION) {
    fail("snapshot.version", "is not supported");
  }
  const factions = arrayAt(member(record, "factions", "snapshot"), "snapshot.factions", MAX_FACTIONS)
    .map((entry, index) => factionAt(entry, `snapshot.factions[${index}]`));
  uniqueIds(factions, "snapshot.factions");
  const consumedCausationIds = stringArray(member(record, "consumedCausationIds", "snapshot"), "snapshot.consumedCausationIds", MAX_CAUSATION_IDS, true);
  const snapshot: PoliticoEconomySnapshot = {
    version: POLITICO_ECONOMY_SNAPSHOT_VERSION,
    round: safeIntegerAt(member(record, "round", "snapshot"), "snapshot.round"),
    events: eventsAt(member(record, "events", "snapshot"), "snapshot.events", MAX_EVENTS, true),
    consumedCausationIds,
    factions,
    factionSystem: factionSystemAt(member(record, "factionSystem", "snapshot"), "snapshot.factionSystem"),
    trades: tradeSystemAt(member(record, "trades", "snapshot"), "snapshot.trades"),
    policies: policySystemAt(member(record, "policies", "snapshot"), "snapshot.policies"),
    finances: financeSystemAt(member(record, "finances", "snapshot"), "snapshot.finances"),
  };
  validateCrossReferences(snapshot);
  return snapshot;
}
