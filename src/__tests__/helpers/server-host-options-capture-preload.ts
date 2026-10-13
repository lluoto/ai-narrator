import { writeFileSync } from "fs";

// This preload observes the actual import.meta.main Bun.serve invocation.
// It is deliberately test-only: production receives no injectable serve seam.
const originalServe = Bun.serve;

Bun.serve = ((...args: Parameters<typeof Bun.serve>) => {
  const capturePath = process.env.SERVER_HOST_OPTIONS_CAPTURE;
  if (capturePath) {
    const options = args[0] as { maxRequestBodySize?: unknown; development?: unknown };
    writeFileSync(capturePath, JSON.stringify({
      maxRequestBodySize: options.maxRequestBodySize,
      development: options.development,
    }), "utf8");
  }
  return originalServe(...args);
}) as typeof Bun.serve;
