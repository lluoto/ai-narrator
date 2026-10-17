import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const gitIndex = process.argv.includes("--git-index");
const manifestPath = path.join(root, "BACKUP_MANIFEST.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

if (!Array.isArray(manifest.files)) {
  throw new Error("BACKUP_MANIFEST.json must contain a files array");
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || /[<>:"\\|?*\u0000-\u001f]/.test(value)) {
    return false;
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return false;
  }
  return value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

let failures = 0;
const seen = new Set();
for (const entry of manifest.files) {
  if (!entry || !safeRelativePath(entry.path)) {
    throw new Error(`unsafe manifest path: ${JSON.stringify(entry?.path)}`);
  }
  const key = entry.path.toLowerCase();
  if (seen.has(key)) {
    throw new Error(`duplicate manifest path: ${entry.path}`);
  }
  seen.add(key);
  if (!safeRelativePath(entry.original_worldmodel_relative_path)) {
    throw new Error(`unsafe original worldmodel relative path: ${JSON.stringify(entry.original_worldmodel_relative_path)}`);
  }
  if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
    throw new Error(`invalid SHA-256 for ${entry.path}`);
  }

  const filePath = path.resolve(root, entry.path);
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`manifest path escapes backup root: ${entry.path}`);
  }

  try {
    const bytes = gitIndex
      ? execFileSync("git", ["show", `:worldmodel/${entry.path}`], {
        cwd: root,
        maxBuffer: 16 * 1024 * 1024,
      })
      : await readFile(filePath);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== entry.sha256) {
      failures += 1;
      console.error(`FAIL ${entry.path}: expected ${entry.sha256}, got ${actual}`);
    } else {
      console.log(`OK ${entry.path}`);
    }
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${entry.path}: ${error.message}`);
  }
}

if (failures) {
  process.exitCode = 1;
} else {
  console.log(`Verified ${manifest.files.length} backup files${gitIndex ? " from Git index" : ""}.`);
}
