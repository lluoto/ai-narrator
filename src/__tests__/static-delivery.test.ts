import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isCanonicalPathContained, serveStaticFile } from "../api/static-delivery";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "static-delivery-"));
  roots.add(root);
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=app></div>");
  writeFileSync(join(root, "assets", "app-abcdefgh.js"), "export const answer = 42;");
  writeFileSync(join(root, "assets", "app..js"), "export const legal = true;");
  return root;
}

function expectStaticSecurityHeaders(response: Response): void {
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  expect(response.headers.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
}

function expectSameStaticMetadata(get: Response, head: Response): void {
  expect(head.status).toBe(get.status);
  for (const header of [
    "Content-Type",
    "Cache-Control",
    "Content-Length",
    "Content-Security-Policy",
    "X-Content-Type-Options",
    "Referrer-Policy",
    "X-Frame-Options",
    "Permissions-Policy",
  ]) {
    expect(head.headers.get(header), header).toBe(get.headers.get(header));
  }
}

describe("static browser delivery", () => {
  test("serves root-contained regular files with cache and browser protections", async () => {
    const root = fixtureRoot();

    const hashed = await serveStaticFile(root, "/assets/app-abcdefgh.js");
    expect(hashed).not.toBeNull();
    expect(await hashed!.text()).toBe("export const answer = 42;");
    expect(hashed!.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(hashed!.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expectStaticSecurityHeaders(hashed!);

    const legalName = await serveStaticFile(root, "/assets/app..js");
    expect(legalName).not.toBeNull();
    expect(await legalName!.text()).toBe("export const legal = true;");

    const document = await serveStaticFile(root, "/index.html");
    expect(document).not.toBeNull();
    expect(document!.headers.get("Cache-Control")).toBe("no-cache");
    expectStaticSecurityHeaders(document!);
    const csp = document!.headers.get("Content-Security-Policy");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(csp).not.toContain("script-src 'unsafe-eval'");
    // Existing Vue UI uses dynamic style attributes. Keep that narrow compatibility
    // exception out of script policy rather than disabling CSP wholesale.
    expect(csp).toContain("style-src-attr 'unsafe-inline'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  test("serves HEAD with GET metadata and no body through the same guarded file contract", async () => {
    const root = fixtureRoot();

    const assetGet = await serveStaticFile(root, "/assets/app-abcdefgh.js", "GET");
    const assetHead = await serveStaticFile(root, "/assets/app-abcdefgh.js", "HEAD");
    expect(assetGet).not.toBeNull();
    expect(assetHead).not.toBeNull();
    expectSameStaticMetadata(assetGet!, assetHead!);
    expect(assetHead!.headers.get("Content-Length")).toBe(String(new TextEncoder().encode("export const answer = 42;").byteLength));
    expect(assetHead!.body).toBeNull();
    expect(await assetHead!.text()).toBe("");

    const documentGet = await serveStaticFile(root, "/index.html", "GET");
    const documentHead = await serveStaticFile(root, "/index.html", "HEAD");
    expect(documentGet).not.toBeNull();
    expect(documentHead).not.toBeNull();
    expectSameStaticMetadata(documentGet!, documentHead!);
    expect(documentHead!.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(documentHead!.body).toBeNull();
    expect(await documentHead!.text()).toBe("");
  });

  test("fails closed for malformed, ambiguous, traversal, and directory paths", async () => {
    const root = fixtureRoot();
    const refused = [
      "assets/app-abcdefgh.js",
      "%2Fassets/app-abcdefgh.js",
      "/assets/%",
      "/%2e%2e/secret.txt",
      "/assets%5capp-abcdefgh.js",
      "/assets/%00app.js",
      "/assets/%1fapp.js",
      "/assets/app-abcdefgh.js:stream",
      "/assets//app-abcdefgh.js",
      "/assets/",
      "/",
      "/assets/./app-abcdefgh.js",
      "/assets",
    ];

    for (const pathname of refused) {
      expect(await serveStaticFile(root, pathname), pathname).toBeNull();
    }
  });

  test("rejects a real symlink or junction escape, with a canonical fallback where Windows denies links", async () => {
    const root = fixtureRoot();
    const outside = mkdtempSync(join(tmpdir(), "static-delivery-outside-"));
    roots.add(outside);
    writeFileSync(join(outside, "secret.txt"), "not a frontend asset");

    let linked = false;
    try {
      // An absolute junction is the Windows-native escape primitive; on other
      // hosts Bun/Node accepts the same target as a directory symlink.
      symlinkSync(outside, join(root, "escaped"), process.platform === "win32" ? "junction" : "dir");
      linked = true;
    } catch {
      // Some managed Windows hosts deny reparse-point creation. This still
      // exercises the production canonical containment predicate, without
      // pretending a fake link proves filesystem behavior.
      expect(isCanonicalPathContained(realpathSync(root), realpathSync(outside))).toBe(false);
    }

    if (linked) {
      expect(await serveStaticFile(root, "/escaped/secret.txt")).toBeNull();
    }
  });
});
