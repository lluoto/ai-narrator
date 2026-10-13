import { expect, it } from "bun:test";
import { compiledModuleHttpFixture } from "./helpers/compiled-module-http-fixture";

it("reuses the deterministic HTTP compiler fixture without sharing caller mutations", async () => {
  const first = await compiledModuleHttpFixture();
  const second = await compiledModuleHttpFixture();

  expect(first).not.toBe(second);
  expect(first.resolved.artifact).not.toBe(second.resolved.artifact);

  const firstPayload = first.resolved.artifact.payload as any;
  const secondPayload = second.resolved.artifact.payload as any;
  firstPayload.draft.sceneCandidates[0].displayName = "mutated fixture scene";
  expect(secondPayload.draft.sceneCandidates[0].displayName).not.toBe("mutated fixture scene");
});
