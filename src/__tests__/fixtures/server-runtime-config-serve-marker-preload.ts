import { writeFileSync } from "node:fs";

const marker = process.env.__SERVER_RUNTIME_CONFIG_SERVE_MARKER;
if (marker) {
  const originalServe = Bun.serve;
  // Bun.serve is writable but deliberately non-configurable in Bun 1.3.
  Bun.serve = ((...args: unknown[]) => {
    writeFileSync(marker, "Bun.serve called", "utf8");
    if (process.env.__SERVER_RUNTIME_CONFIG_SERVE_THROW === "1") {
      throw new Error("Bun.serve marker preload intentionally stopped listener creation");
    }
    return Reflect.apply(originalServe, Bun, args);
  }) as typeof Bun.serve;
}
