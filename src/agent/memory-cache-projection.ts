import type { MemoryEntry } from "./types";

/**
 * The in-process NPC prompt cache intentionally has a smaller bound than the
 * durable memory table.  Keep the established candidate policy separate from
 * the durable backing projection: a cache entry may be omitted from SQLite's
 * large history, but it must never survive in the cache after SQLite prunes
 * its backing row.
 */
const CACHE_PRUNE_AT = 50;
const CACHE_RETAIN_COUNT = 40;

export function cloneNPCMemory(entry: MemoryEntry): MemoryEntry {
  const cloned: MemoryEntry = {
    timestamp: entry.timestamp,
    type: entry.type,
    content: entry.content,
    importance: entry.importance,
  };
  if (entry.scene_id !== undefined) cloned.scene_id = entry.scene_id;
  if (entry.related_entities !== undefined) cloned.related_entities = [...entry.related_entities];
  if (entry.is_summary !== undefined) cloned.is_summary = entry.is_summary;
  return cloned;
}

/** The pre-durable bounded-cache candidate; retained for no-store operation. */
export function appendNPCMemoryCacheCandidate(
  memories: readonly MemoryEntry[],
  entry: MemoryEntry,
): MemoryEntry[] {
  let next = [...memories.map(cloneNPCMemory), cloneNPCMemory(entry)];
  if (next.length > CACHE_PRUNE_AT) {
    next.sort((left, right) => right.importance - left.importance);
    next = next.slice(0, CACHE_RETAIN_COUNT);
  }
  return next;
}

function memoryMultisetKey(entry: MemoryEntry): string {
  return JSON.stringify([
    entry.timestamp,
    entry.type,
    entry.content,
    entry.importance,
    entry.scene_id ?? "",
    entry.related_entities ?? [],
    entry.is_summary ?? false,
  ]);
}

function freezeMemory(entry: MemoryEntry): MemoryEntry {
  const frozen = cloneNPCMemory(entry);
  if (frozen.related_entities !== undefined) Object.freeze(frozen.related_entities);
  return Object.freeze(frozen) as MemoryEntry;
}

/**
 * Return a detached immutable bounded live projection. `durableMemories` is a
 * multiset because equal event payloads are legal and must not be overused by
 * the cache.  The same function covers no-DB operation by passing its own
 * candidate as the backing multiset.
 */
export function projectNPCMemoryCache(
  candidate: readonly MemoryEntry[],
  durableMemories: readonly MemoryEntry[],
): readonly MemoryEntry[] {
  const available = new Map<string, number>();
  for (const memory of durableMemories) {
    const key = memoryMultisetKey(memory);
    available.set(key, (available.get(key) ?? 0) + 1);
  }

  const projected: MemoryEntry[] = [];
  for (const memory of candidate) {
    const key = memoryMultisetKey(memory);
    const count = available.get(key) ?? 0;
    if (count === 0) continue;
    available.set(key, count - 1);
    projected.push(freezeMemory(memory));
  }
  return Object.freeze(projected);
}
