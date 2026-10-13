import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const serverSource = () => readFileSync(join(import.meta.dir, "../api/server.ts"), "utf8");

describe("server legacy runtime-mutation retirement", () => {
  test("keeps direct KP mutation authority and the return-after-durable character handler out of the HTTP server", () => {
    const source = serverSource();
    const forbidden = [
      ["legacy KP direct-route switch", source.includes('if (method === "POST" && segments[3] === "kp" && segments.length === 5) {')],
      ["direct KP sendMessage", source.includes("session.sendMessage(")],
      ["direct KP setPlayerSan", source.includes("session.setPlayerSan(")],
      ["direct KP setPlayerHp", source.includes("session.setPlayerHp(")],
      ["direct KP applyDamage", source.includes("session.applyDamage(")],
      ["direct KP setScene", source.includes("session.setScene(")],
      ["direct KP setDifficulty", source.includes("session.setDifficulty(")],
      ["return-after-durable character session alias", source.includes("const legacySession = session!;")],
      ["return-after-durable character body parser", source.includes("const body = (await readRequiredJsonRecord(req)) as JsonRecord;")],
    ].filter(([, present]) => present).map(([name]) => name);

    expect(forbidden).toEqual([]);
  });
});
