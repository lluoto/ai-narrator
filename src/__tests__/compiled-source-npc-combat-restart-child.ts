import { GameSession } from "../api/game-session";
import { CompiledSessionSnapshotStore } from "../api/compiled-session-snapshot";
import { CompilerArtifactCatalog } from "../compiler/compiler-artifact-catalog";
import { join } from "path";

const [root, sessionId, bundleId] = process.argv.slice(2);
if (!root || !sessionId || !bundleId) throw new Error("expected durable combat root, session ID, and bundle ID");

const catalog = new CompilerArtifactCatalog({ root: join(root, "catalog") });
const bundle = catalog.loadBundle(bundleId);
if (bundle.status !== "ok") throw new Error(bundle.message);
const snapshots = new CompiledSessionSnapshotStore({ root: join(root, "snapshots"), allowUncoordinatedTestWrites: true });
const snapshot = snapshots.read(sessionId);
if (snapshot.status !== "ok") throw new Error(snapshot.message);
const session = new GameSession(sessionId, "cosmic-horror", { apiKey: "sk-placeholder", baseUrl: "http://offline.invalid", model: "offline", maxTokens: 1, temperature: 0 }, undefined, undefined, undefined, { careerRoot: join(root, "child-careers") });
const restored = session.restoreCompiledSession(snapshot.value, bundle.value);
if (restored.status === "refused") throw new Error(restored.message);
const state = session.getState();
console.log(JSON.stringify({ hp: state.player.hp, monsters: state.monsters, generation: session.getCompiledGeneration() }));
