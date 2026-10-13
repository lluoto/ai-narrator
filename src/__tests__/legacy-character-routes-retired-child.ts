import { existsSync } from "fs";
import { join } from "path";
import type { CompilerRequestAuthenticator } from "../api/compiled-module-http";
import { handleRequest } from "../api/server";

const root = process.cwd();
const storage = { careerRoot: join(root, "careers"), sessionRoot: join(root, "sessions") };
const characterDir = join(root, "data", "characters");

const unauthenticated: CompilerRequestAuthenticator = () => ({ status: "unauthenticated" });
const authenticated: CompilerRequestAuthenticator = () => ({
  status: "authenticated",
  principal: { id: "keeper:legacy-character-route-test", role: "keeper" },
});

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
    new Request(`http://legacy-character-route-test${path}`, init),
    undefined,
    undefined,
    storage,
    {},
    {},
    authenticator,
  );
}

async function main(): Promise<void> {
  const anonymousPostBody = unreadJsonBody({ name: "Anonymous write" });
  const authenticatedPostBody = unreadJsonBody({ name: "Authenticated write" });
  const anonymousGet = await request("/api/characters", unauthenticated);
  const authenticatedGet = await request("/api/characters", authenticated);
  const anonymousPost = await request("/api/characters", unauthenticated, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: anonymousPostBody.body,
  });
  const authenticatedPost = await request("/api/characters", authenticated, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: authenticatedPostBody.body,
  });

  console.log("@@legacy-character-routes-retired@@" + JSON.stringify({
    legacy: {
      anonymousGet: anonymousGet.status,
      authenticatedGet: authenticatedGet.status,
      anonymousPost: anonymousPost.status,
      authenticatedPost: authenticatedPost.status,
      anonymousPostPulls: anonymousPostBody.pulls(),
      authenticatedPostPulls: authenticatedPostBody.pulls(),
      characterDirExists: existsSync(characterDir),
    },
  }));
}

await main();
