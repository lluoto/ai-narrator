import { existsSync } from "fs";
import { join } from "path";
import { deleteModuleFile, loadModuleFile, parseMythosModule, saveModuleFile } from "../api/module-editor";
import { handleRequest } from "../api/server";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import type { MythosModule } from "../rules/mythos-module";

const root = process.cwd();
const modulesDir = join(root, "data", "modules");
const escapedFile = join(root, "escape.json");
const storage = { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") };

const unauthenticated: CompilerRequestAuthenticator = () => ({ status: "unauthenticated" });
const operator: CompilerRequestAuthenticator = () => ({
  status: "authenticated",
  principal: { id: "operator:module-editor-test", role: "operator" },
});
const keeper: CompilerRequestAuthenticator = () => ({
  status: "authenticated",
  principal: { id: "keeper:module-editor-test", role: "keeper" },
});
const unavailable: CompilerRequestAuthenticator = () => ({ status: "unavailable" });

function moduleBody(id: string, name = "Module editor test"): Record<string, unknown> {
  return {
    id,
    name,
    version: "1.0",
    description: "A module-editor contract fixture.",
    difficulty: "medium",
    activation: { type: "manual", condition: "start" },
  };
}

function unreadJsonBody(value: unknown): { body: ReadableStream<Uint8Array>; pulls: () => number } {
  let pullCount = 0;
  return {
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
        controller.close();
      },
    }, { highWaterMark: 0 }),
    pulls: () => pullCount,
  };
}

async function request(
  path: string,
  authenticator: CompilerRequestAuthenticator,
  init: RequestInit = {},
): Promise<Response> {
  return handleRequest(
    new Request(`http://module-editor-test${path}`, init),
    undefined,
    undefined,
    storage,
    {},
    {},
    authenticator,
  );
}

async function main(): Promise<void> {
  const post = unreadJsonBody(moduleBody("../../escape"));
  const deleted = unreadJsonBody({ ignored: true });
  const anonymous = {
    list: await request("/api/modules", unauthenticated),
    get: await request("/api/modules/ordinary_module", unauthenticated),
    post: await request("/api/modules", unauthenticated, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: post.body,
    }),
    delete: await request("/api/modules/ordinary_module", unauthenticated, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: deleted.body,
    }),
    postPulls: post.pulls(),
    deletePulls: deleted.pulls(),
    modulesDirExists: existsSync(modulesDir),
    escapedFileExists: existsSync(escapedFile),
  };

  const invalidPost = await request("/api/modules", operator, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(moduleBody("../../escape")),
  });
  const encodedGet = await request("/api/modules/%2e%2e%2fescape", operator);
  const encodedDelete = await request("/api/modules/%2e%2e%2fescape", operator, { method: "DELETE" });
  const unsafeIds = [".", "..", "../escape", "..\\escape", "C:\\escape", "/absolute", "%2e%2e%2fescape", "safe/escape", "safe\\escape", "\u00e9scape"];
  let directSaveRefused = true;
  let directDeleteRefused = true;
  let directLoadRefused = true;
  let allUnsafeIdsRefused = true;
  for (const unsafeId of unsafeIds) {
    try { saveModuleFile(moduleBody(unsafeId) as unknown as MythosModule); directSaveRefused = false; } catch { /* expected */ }
    try { deleteModuleFile(unsafeId); directDeleteRefused = false; } catch { /* expected */ }
    if (loadModuleFile(unsafeId) !== null) directLoadRefused = false;
    if (parseMythosModule(moduleBody(unsafeId)).ok) allUnsafeIdsRefused = false;
  }

  const keeperList = await request("/api/modules", keeper);
  const unavailableList = await request("/api/modules", unavailable);
  const keeperPostBody = unreadJsonBody(moduleBody("keeper_attempt"));
  const keeperPost = await request("/api/modules", keeper, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: keeperPostBody.body,
  });
  const keeperDelete = await request("/api/modules/ordinary_module", keeper, { method: "DELETE" });
  const forgedPostBody = unreadJsonBody({ ...moduleBody("forged_attempt"), role: "operator" });
  const forgedHeader = await request("/api/modules", unauthenticated, {
    method: "POST",
    headers: { "Authorization": "Bearer caller-controlled", "X-Compiler-Role": "operator", "Content-Type": "application/json" },
    body: forgedPostBody.body,
  });

  const id = "ui_module-2026";
  const saved = await request("/api/modules", operator, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(moduleBody(id, "Initial UI module")),
  });
  const listed = await request("/api/modules", operator);
  const loaded = await request(`/api/modules/${id}`, operator);
  const updated = await request(`/api/modules/${id}`, operator, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Updated UI module" }),
  });
  const updatedLoaded = await request(`/api/modules/${id}`, operator);
  const removed = await request(`/api/modules/${id}`, operator, { method: "DELETE" });
  const missing = await request(`/api/modules/${id}`, operator);
  console.log("@@module-editor-security@@" + JSON.stringify({
    anonymous: {
      list: anonymous.list.status,
      get: anonymous.get.status,
      post: anonymous.post.status,
      delete: anonymous.delete.status,
      postPulls: anonymous.postPulls,
      deletePulls: anonymous.deletePulls,
      modulesDirExists: anonymous.modulesDirExists,
      escapedFileExists: anonymous.escapedFileExists,
    },
    unsafe: {
      post: invalidPost.status,
      encodedGet: encodedGet.status,
      encodedDelete: encodedDelete.status,
      directSaveRefused,
      directDeleteRefused,
      directLoadRefused,
      allUnsafeIdsRefused,
      escapedFileExists: existsSync(escapedFile),
    },
    authority: {
      keeperList: keeperList.status,
      keeperPost: keeperPost.status,
      keeperPostPulls: keeperPostBody.pulls(),
      keeperDelete: keeperDelete.status,
      unavailableList: unavailableList.status,
      forgedHeader: forgedHeader.status,
      forgedPostPulls: forgedPostBody.pulls(),
    },
    uiCrud: {
      saved: saved.status,
      listed: listed.status,
      listedBody: await listed.json(),
      loaded: loaded.status,
      loadedBody: await loaded.json(),
      updated: updated.status,
      updatedLoaded: updatedLoaded.status,
      updatedLoadedBody: await updatedLoaded.json(),
      removed: removed.status,
      missing: missing.status,
    },
  }));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
