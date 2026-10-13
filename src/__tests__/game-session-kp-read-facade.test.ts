import { describe, expect, it } from "bun:test";
import { KPAgent } from "../agent/kp-agent";
import { GameSession } from "../api/game-session";

const CONFIG = {
  apiKey: "",
  baseUrl: "http://offline.invalid",
  model: "offline",
  maxTokens: 1,
  temperature: 0,
};

function makeSession(id: string): GameSession {
  return new GameSession(id, "cosmic-horror", CONFIG, "investigator", "Ada");
}

describe("GameSession.kp read facade", () => {
  it("is a stable, frozen prototype getter with exactly the two detached readers", () => {
    const session = makeSession("kp-facade-shape");
    try {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(session), "kp");
      expect(typeof descriptor?.get).toBe("function");
      expect(descriptor?.set).toBeUndefined();
      expect(Object.hasOwn(session, "kp")).toBe(false);

      const kp = session.kp as unknown as Record<string, unknown>;
      expect(session.kp as unknown).toBe(kp);
      expect(Object.isFrozen(kp)).toBe(true);
      expect(Object.keys(kp).sort()).toEqual(["getDirective", "getTurns"]);
      for (const forbidden of [
        "updateDirective",
        "setWorldModelContext",
        "describeScene",
        "narrateOutcome",
        "injectEvent",
        "transitionScene",
        "recordTurn",
        "raw",
      ]) {
        expect(forbidden in kp).toBe(false);
      }
    } finally {
      session.close();
    }
  });

  it("clones and recursively freezes directive and turn graphs instead of returning KP aliases", () => {
    const session = makeSession("kp-facade-detachment");
    const originalDirective = KPAgent.prototype.getDirective;
    const originalTurns = KPAgent.prototype.getTurns;
    const rawDirective = {
      scene_description: "raw scene",
      scene_elements: ["raw element"],
      current_phase: "raw phase",
      style: "standard" as const,
      plot_nodes: [{ id: "raw-node", description: "raw nested node", trigger: "never", done: false }],
    };
    const rawTurns = [{
      round: 1,
      timestamp: 1,
      player_input: "raw input",
      messages: [{ speaker: "KP", content: "raw nested message", type: "narration" as const }],
      world_snapshot: null,
    }];
    try {
      (KPAgent.prototype as any).getDirective = () => rawDirective;
      (KPAgent.prototype as any).getTurns = () => rawTurns;

      const directive = session.kp.getDirective() as any;
      const turns = session.kp.getTurns() as any;
      expect(directive).not.toBe(rawDirective);
      expect(turns).not.toBe(rawTurns);
      expect(Object.isFrozen(directive)).toBe(true);
      expect(Object.isFrozen(directive.scene_elements)).toBe(true);
      expect(Object.isFrozen(directive.plot_nodes)).toBe(true);
      expect(Object.isFrozen(directive.plot_nodes[0])).toBe(true);
      expect(Object.isFrozen(turns)).toBe(true);
      expect(Object.isFrozen(turns[0])).toBe(true);
      expect(Object.isFrozen(turns[0].messages)).toBe(true);
      expect(Object.isFrozen(turns[0].messages[0])).toBe(true);
      expect(() => directive.plot_nodes[0].done = true).toThrow(TypeError);
      expect(() => turns[0].messages.push({ speaker: "external" })).toThrow(TypeError);
      expect(rawDirective.plot_nodes[0]?.done).toBe(false);
      expect(rawTurns[0]?.messages).toHaveLength(1);
    } finally {
      (KPAgent.prototype as any).getDirective = originalDirective;
      (KPAgent.prototype as any).getTurns = originalTurns;
      session.close();
    }
  });

  it("keeps opening, world-context, and ordinary narration on canonical private KP despite a public reflection mask", async () => {
    const session = makeSession("kp-facade-reflection");
    const fake = {
      contextWrites: 0,
      openingCalls: 0,
      narrationCalls: 0,
      setWorldModelContext() { this.contextWrites++; },
      async describeScene() { this.openingCalls++; return "FORGED PUBLIC KP OPENING"; },
      async narrateOutcome() { this.narrationCalls++; return "FORGED PUBLIC KP NARRATION"; },
    };
    try {
      Object.defineProperty(session, "kp", { configurable: true, value: fake });

      const opening = await session.getOpeningScene();
      expect(opening).not.toBe("FORGED PUBLIC KP OPENING");
      expect(fake.contextWrites).toBe(0);
      expect(fake.openingCalls).toBe(0);

      const action = await session.act("我对着空荡的走廊轻声哼唱一段从未听过的曲子");
      expect(fake.narrationCalls).toBe(0);
      expect(action.narrative).not.toBe("FORGED PUBLIC KP NARRATION");
    } finally {
      session.close();
    }
  });
});
