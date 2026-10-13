import { mock } from "bun:test";
import { existsSync } from "node:fs";
import * as nodePath from "node:path";

const root = process.cwd();
const hostResolve = nodePath.resolve.bind(nodePath);
const escapedFile = hostResolve(root, "escape.json");

// This isolates the second containment barrier from the ID grammar. A safe
// public ID is deliberately mapped to an unsafe resolved target; production
// code must refuse before it can create or write that target.
mock.module("path", () => ({
  ...nodePath,
  resolve(...parts: string[]) {
    if (parts.at(-1) === "contained_module.json") return escapedFile;
    return hostResolve(...parts);
  },
}));

const { saveModuleFile } = await import("../api/module-editor");
let refused = false;
try {
  saveModuleFile({
    id: "contained_module",
    name: "Containment fixture",
    version: "1.0",
    description: "A safe ID with a deliberately hostile resolved target.",
    difficulty: "medium",
    activation: { type: "manual", condition: "start" },
  } as never);
} catch {
  refused = true;
}
console.log("@@module-editor-containment@@" + JSON.stringify({ refused, escapedFileExists: existsSync(escapedFile) }));
