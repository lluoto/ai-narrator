import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CareerFileStore,
  CareerProjectionPredecessorConflict,
  type CareerOrdinaryProjectionCommit,
  type CareerPortableProjection,
  type CareerPortableProjectionIdentity,
} from "../character/career-file";

const roots = new Set<string>();
const SESSION_ID = "12345678-1234-4123-8123-123456789abc";
const EMPTY_PROJECTION: CareerPortableProjection = { version: 1, records: [] };

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "career-orphan-projection-stage-"));
  roots.add(value);
  return value;
}

function versionRoot(directory: string): string {
  return join(directory, ".career-projections");
}

function stageNames(directory: string): string[] {
  return readdirSync(versionRoot(directory)).filter((name) => name.startsWith("projection-")).sort();
}

function activeStage(directory: string): string {
  const pointer = JSON.parse(readFileSync(join(directory, ".career-active.json"), "utf8")) as { active?: unknown };
  if (typeof pointer.active !== "string") throw new Error("fixture Career pointer is unavailable");
  return pointer.active;
}

function createManagedStore(): { directory: string; store: CareerFileStore } {
  const directory = join(root(), "careers", SESSION_ID);
  const store = new CareerFileStore(directory);
  store.replacePortableProjection(EMPTY_PROJECTION);
  return { directory, store };
}

/** Copy a fully completed immutable stage into a fresh valid version name. */
function seedCompletedOrphans(directory: string, count: number): string[] {
  const container = versionRoot(directory);
  const source = join(container, activeStage(directory));
  const result: string[] = [];
  for (let index = 1; index <= count; index++) {
    const name = `projection-00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    cpSync(source, join(container, name), { recursive: true, errorOnExist: true });
    result.push(name);
  }
  return result;
}

function preparePendingJournal(store: CareerFileStore): CareerOrdinaryProjectionCommit {
  const predecessor = store.capturePortableProjectionIdentity();
  return store.prepareOrdinaryProjectionCommit({
    sessionId: SESSION_ID,
    predecessorGeneration: 0,
    predecessorEnvelopeHash: "a".repeat(64),
    generation: 1,
    envelopeHash: "b".repeat(64),
    predecessor,
  }, EMPTY_PROJECTION);
}

function stageUnderHeldRootFence(store: CareerFileStore): CareerPortableProjectionIdentity {
  const internal = store as unknown as {
    withRootWriteLock<T>(operation: () => T): T;
    stagePortableProjection(projection: CareerPortableProjection): CareerPortableProjectionIdentity;
  };
  return internal.withRootWriteLock(() => internal.stagePortableProjection(EMPTY_PROJECTION));
}

test("a new root-fenced writer reclaims one completed unreferenced stage before publishing", () => {
  const { directory, store } = createManagedStore();
  const [orphan] = seedCompletedOrphans(directory, 1);
  expect(stageNames(directory)).toHaveLength(2);

  expect(() => store.replacePortableProjection(EMPTY_PROJECTION)).not.toThrow();
  expect(existsSync(join(versionRoot(directory), orphan))).toBe(false);
  expect(stageNames(directory)).toHaveLength(1);
});

test("new projection construction begins in a non-authoritative building namespace", () => {
  const { directory, store } = createManagedStore();
  const internal = store as unknown as {
    withRootWriteLock<T>(operation: () => T): T;
    createProjectionStage(): { name: string; directory: string };
  };
  const stage = internal.withRootWriteLock(() => internal.createProjectionStage());

  // A crash between mkdir and completion must not leave anything that looks
  // like a possibly-authoritative projection version. Publication owns the
  // sole transition to projection-*.
  expect(stage.name).toMatch(/^building-[0-9a-f-]+$/i);
  expect(stage.directory).toBe(join(versionRoot(directory), stage.name));
  expect(stageNames(directory)).toHaveLength(1);
});

test("reclaims a full seven-stage orphan backlog before the eighth-stage capacity fence", () => {
  const { directory, store } = createManagedStore();
  const orphans = seedCompletedOrphans(directory, 7);
  expect(stageNames(directory)).toHaveLength(8);

  expect(() => store.replacePortableProjection(EMPTY_PROJECTION)).not.toThrow();
  expect(stageNames(directory)).toHaveLength(1);
  for (const orphan of orphans) expect(existsSync(join(versionRoot(directory), orphan))).toBe(false);
});

test("never reclaims active or pending-journal predecessor/successor stages", () => {
  const { directory, store } = createManagedStore();
  const [orphan] = seedCompletedOrphans(directory, 1);
  const commit = preparePendingJournal(store);
  expect(existsSync(join(versionRoot(directory), orphan))).toBe(false);
  expect(activeStage(directory)).toBe(commit.predecessor.version);
  expect(existsSync(join(versionRoot(directory), commit.predecessor.version))).toBe(true);
  expect(existsSync(join(versionRoot(directory), commit.successor.version))).toBe(true);
  expect(existsSync(join(directory, ".ordinary-career-projection-commit.json"))).toBe(true);

  // Production writers reject a pending journal before staging. This direct
  // held-fence seam exercises the same cleanup path and proves both journal
  // identities remain protected even while another stage is constructed.
  expect(() => stageUnderHeldRootFence(store)).not.toThrow();
  expect(activeStage(directory)).toBe(commit.predecessor.version);
  expect(existsSync(join(versionRoot(directory), commit.predecessor.version))).toBe(true);
  expect(existsSync(join(versionRoot(directory), commit.successor.version))).toBe(true);
  expect(() => store.replacePortableProjection(EMPTY_PROJECTION)).toThrow(CareerProjectionPredecessorConflict);
});

test("unknown, non-directory, or malformed stage entries fail closed without new publication", () => {
  const cases: Array<{ name: string; install(directory: string): string }> = [
    {
      name: "unknown", install(directory) {
        const target = join(versionRoot(directory), "unrecognized-stage");
        mkdirSync(target); return target;
      },
    },
    {
      name: "non-directory", install(directory) {
        const target = join(versionRoot(directory), "projection-00000000-0000-4000-8000-0000000000aa");
        writeFileSync(target, "not a directory", "utf8"); return target;
      },
    },
    {
      name: "unexpected leaf", install(directory) {
        const [stage] = seedCompletedOrphans(directory, 1);
        const target = join(versionRoot(directory), stage, "unexpected-leaf.json");
        writeFileSync(target, "{}", "utf8"); return target;
      },
    },
  ];
  for (const candidate of cases) {
    const { directory, store } = createManagedStore();
    const activeBefore = activeStage(directory);
    const target = candidate.install(directory);
    expect(() => store.replacePortableProjection(EMPTY_PROJECTION)).toThrow();
    expect(activeStage(directory)).toBe(activeBefore);
    expect(existsSync(target)).toBe(true);
  }
});
