import { writeFileSync } from "node:fs";

const marker = process.env.__SERVER_RUNTIME_CONFIG_CREATION_PROVIDER_MARKER;

// The real main test starts a child with a nominal provider configuration. A
// correctly rejected capacity request never reaches this process-local seam.
const originalFetch = globalThis.fetch;
const markerFetch = Object.assign(
  async (..._args: Parameters<typeof fetch>): Promise<Response> => {
    if (marker) writeFileSync(marker, "provider-called");
    return new Response(JSON.stringify({ choices: [{ message: { content: "unexpected provider call" } }] }), {
      headers: { "Content-Type": "application/json" },
    });
  },
  { preconnect: originalFetch.preconnect },
);
globalThis.fetch = markerFetch;
