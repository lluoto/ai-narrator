import { existsSync, writeFileSync } from "fs";
import { CompiledPlayerDelivery, CompiledPlayerDeliveryClaimStore, compiledPlayerDeliveryClaimStoreNodeFileOps } from "../api/player-delivery";
import { CompiledPlayerDeliveryClaimCoordinator } from "../api/player-delivery-claim-coordinator";

const [mode, root, sessionId, encodedGrant, invite, claimId, ready, release, rawCookie] = process.argv.slice(2);
if (!mode || !root || !ready || !release) throw new Error("expected claim-process child arguments");

const secret = "delivery_hmac_secret_".padEnd(48, "d");
const pause = () => {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(release!)) Atomics.wait(gate, 0, 0, 20);
};

if (mode === "claim-hold") {
  if (!sessionId || !encodedGrant || !invite || !claimId) throw new Error("claim-holder arguments are incomplete");
  const store = new CompiledPlayerDeliveryClaimStore(root, {
    ops: {
      ...compiledPlayerDeliveryClaimStoreNodeFileOps,
      link(temporary, final) {
        writeFileSync(ready!, "before-link");
        pause();
        compiledPlayerDeliveryClaimStoreNodeFileOps.link(temporary, final);
      },
    },
  });
  const delivery = new CompiledPlayerDelivery({ secret, publicOrigin: "https://example.test", claims: store });
  const result = delivery.claim(sessionId, JSON.parse(encodedGrant), invite, claimId);
  console.log(JSON.stringify({ result }));
} else if (mode === "claim") {
  if (!sessionId || !encodedGrant || !invite || !claimId) throw new Error("claimant arguments are incomplete");
  const delivery = new CompiledPlayerDelivery({
    secret,
    publicOrigin: "https://example.test",
    claims: new CompiledPlayerDeliveryClaimStore(root),
  });
  const result = delivery.claim(sessionId, JSON.parse(encodedGrant), invite, claimId);
  console.log(JSON.stringify({ result }));
} else if (mode === "lock-hold") {
  const coordinator = new CompiledPlayerDeliveryClaimCoordinator(root);
  coordinator.initialize();
  coordinator.withExclusive(() => {
    writeFileSync(ready!, "locked");
    pause();
  });
  console.log(JSON.stringify({ released: true }));
} else if (mode === "authenticate") {
  if (!sessionId || !encodedGrant || !rawCookie) throw new Error("authentication arguments are incomplete");
  const store = new CompiledPlayerDeliveryClaimStore(root);
  const delivery = new CompiledPlayerDelivery({ secret, publicOrigin: "https://example.test", claims: store });
  const read = store.read(sessionId);
  console.log(JSON.stringify({
    authenticated: delivery.authenticate(sessionId, JSON.parse(encodedGrant), rawCookie),
    read: read === undefined ? "undefined" : read === null ? "null" : "value",
  }));
} else {
  throw new Error(`unsupported claim-process mode: ${mode}`);
}
