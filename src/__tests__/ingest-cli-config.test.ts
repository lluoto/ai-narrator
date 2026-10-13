import { describe, expect, test } from "bun:test";
import { join } from "path";
import {
  DEFAULT_INGEST_OUTPUT_DIR,
  parseE2ERunConfig,
  parseIngestRunConfig,
} from "../../scripts/ingest/cli-config";

function ingestConfig(args: string[], env: Record<string, string | undefined> = {}) {
  const result = parseIngestRunConfig(args, env);
  if (!result.ok) throw new Error(result.message);
  return result.config;
}

function e2eConfig(args: string[], env: Record<string, string | undefined> = {}) {
  const result = parseE2ERunConfig(args, env);
  if (!result.ok) throw new Error(result.message);
  return result.config;
}

describe("ingest CLI configuration", () => {
  test("requires an explicit module id for a PDF without a selected baseline", () => {
    const result = parseIngestRunConfig(["C:\\imports\\unrelated.pdf"], {});

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("--module-id");
  });

  test("uses explicit CLI identity and output settings ahead of environment values", () => {
    const config = ingestConfig(
      ["from-cli.pdf", "--module-id", "cli-module", "--title", "CLI supplied title", "--out", "custom-output"],
      {
        INGEST_PDF: "from-env.pdf",
        INGEST_MODULE_ID: "env-module",
        INGEST_MODULE_TITLE: "environment title",
        INGEST_OUT: "environment-output",
      },
    );

    expect(config).toEqual({
      pdfPath: "from-cli.pdf",
      moduleId: "cli-module",
      moduleTitle: "CLI supplied title",
      outputDir: "custom-output",
      baseline: undefined,
    });
  });

  test("uses only the PDF filename as the non-baseline title fallback", () => {
    const config = ingestConfig(["C:\\imports\\The Beetle.pdf", "--module-id", "beetle-ingested"]);

    expect(config.moduleId).toBe("beetle-ingested");
    expect(config.moduleTitle).toBe("The Beetle");
    expect(config.moduleId).not.toContain("barn");
  });

  test("permits barn identity only when the barn baseline is explicitly selected", () => {
    const config = ingestConfig(["barn.pdf"], { INGEST_BASELINE: "barn" });

    expect(config).toMatchObject({
      baseline: "barn",
      moduleId: "barn-of-premier-ingested",
    });
  });

  test("shares default and explicit output-directory resolution with e2e-run", () => {
    const run = ingestConfig(["source.pdf", "--module-id", "source-ingested"]);
    const e2eDefault = e2eConfig([]);
    const e2eCustom = e2eConfig(["--out", "custom-output"]);

    expect(run.outputDir).toBe(DEFAULT_INGEST_OUTPUT_DIR);
    expect(e2eDefault.modulePath).toBe(join(DEFAULT_INGEST_OUTPUT_DIR, "module.json"));
    expect(e2eCustom.modulePath).toBe(join("custom-output", "module.json"));
  });
});
