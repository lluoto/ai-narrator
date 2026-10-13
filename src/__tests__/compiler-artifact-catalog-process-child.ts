import { readSync } from "fs";
import { CompilerArtifactCatalog, compilerArtifactCatalogNodeFileOps } from "../compiler/compiler-artifact-catalog";
import { compiledModuleHttpFixture } from "./helpers/compiled-module-http-fixture";

const root = process.env.CATALOG_PROCESS_ROOT;
const entryCharacter = process.env.CATALOG_PROCESS_ID;
if (!root || !entryCharacter || !/^[a-z2-7]$/.test(entryCharacter)) throw new Error("catalog process child requires root and valid ID character");

const holdMode = process.env.CATALOG_PROCESS_HOLD ?? "";
let announced = false;
function announceAndBlock(event: "ready-after-usage" | "ready-after-temp-flush"): void {
  if (announced) return;
  announced = true;
  process.stdout.write(`${JSON.stringify({ event })}\n`);
  readSync(0, new Uint8Array(1), 0, 1, null);
}
const fileOps = holdMode ? {
  ...compilerArtifactCatalogNodeFileOps,
  open(path: string): number {
    if (holdMode === "usage") announceAndBlock("ready-after-usage");
    return compilerArtifactCatalogNodeFileOps.open(path);
  },
  flush(fd: number): void {
    compilerArtifactCatalogNodeFileOps.flush(fd);
    if (holdMode === "temp-flush") announceAndBlock("ready-after-temp-flush");
  },
} : compilerArtifactCatalogNodeFileOps;

const fixture = await compiledModuleHttpFixture();
const catalogOptions: Record<string, unknown> = {
  root,
  maxEntries: Number(process.env.CATALOG_PROCESS_MAX_ENTRIES ?? "1000"),
  maxBytes: Number(process.env.CATALOG_PROCESS_MAX_BYTES ?? `${128 * 1024 * 1024}`),
  generateId: () => entryCharacter.repeat(24),
  now: () => process.env.CATALOG_PROCESS_NOW ?? "2026-08-01T00:00:00.000Z",
  fileOps,
};
if (process.env.CATALOG_PROCESS_COORDINATOR_SCHEMA) catalogOptions.coordinatorSchemaVersion = process.env.CATALOG_PROCESS_COORDINATOR_SCHEMA;
const catalog = new CompilerArtifactCatalog(catalogOptions);
const result = catalog.savePrepared(fixture.prepared.artifact);
process.stdout.write(`${JSON.stringify({ event: "result", result })}\n`);
