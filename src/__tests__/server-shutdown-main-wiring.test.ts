import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const serverSource = readFileSync(resolve(import.meta.dir, "..", "api", "server.ts"), "utf8");

test("main host saves its listener and cleanup timer behind the shutdown request gate", () => {
  const mainStart = serverSource.indexOf("if (import.meta.main)");
  const timer = serverSource.indexOf("const cleanupTimer = setInterval");
  const listener = serverSource.indexOf("const liveServer = Bun.serve");
  const controller = serverSource.indexOf("shutdownController = createServerShutdownController");
  const requestGate = serverSource.indexOf("shutdownController.trackRequest");
  const signals = serverSource.indexOf("bindShutdownSignals(shutdownController)");

  expect(mainStart).toBeGreaterThan(-1);
  expect(timer).toBeGreaterThan(mainStart);
  expect(listener).toBeGreaterThan(timer);
  expect(controller).toBeGreaterThan(listener);
  expect(requestGate).toBeGreaterThan(listener);
  expect(signals).toBeGreaterThan(controller);
  expect(serverSource).toContain("closeWebSockets: closeAllWsClients");
  expect(serverSource).toContain("beginWebSocketAdmissionDrain: () => serverOrdinaryWebSocketAdmission.beginDraining()");
  expect(serverSource).toContain("onGraceTimeout: () => log.error(\"shutdown\"");

  const fetchStart = serverSource.indexOf("async fetch(req, server)", listener);
  const fetchEnd = serverSource.indexOf("websocket: createOrdinarySessionWebSocketHandler", fetchStart);
  const fetchSource = serverSource.slice(fetchStart, fetchEnd);
  expect(fetchSource.indexOf("shutdownController.trackRequest")).toBeLessThan(fetchSource.indexOf("new URL(req.url)"));
  expect(fetchSource.indexOf("shutdownController.trackRequest")).toBeLessThan(fetchSource.indexOf("admitOrdinarySessionWebSocketUpgrade"));
});
