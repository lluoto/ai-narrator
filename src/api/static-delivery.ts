import { realpath, stat } from "fs/promises";
import { isAbsolute, relative, resolve, sep } from "path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
};

const STATIC_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

// Vue's current screens bind dynamic style attributes. The attribute-only
// exception preserves that behavior without allowing inline or evaluated JS.
// Their forms use Vue's `@submit.prevent` and fetch, so native form navigation
// is not needed at this delivery boundary.
const HTML_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ");

export type StaticDeliveryMethod = "GET" | "HEAD";

/** True only when `candidate` resolves inside (or exactly at) the canonical root. */
export function isCanonicalPathContained(canonicalRoot: string, candidate: string): boolean {
  const pathFromRoot = relative(canonicalRoot, candidate);
  return pathFromRoot === ""
    || (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`));
}

function requestPathSegments(pathname: string): { decoded: string; segments: string[] } | null {
  if (!pathname.startsWith("/")) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.includes("\\") || /[\u0000-\u001f\u007f]/.test(decoded)) return null;

  const segments = decoded.slice(1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes(":"))) return null;
  return { decoded, segments };
}

/**
 * Resolves and serves a static build artifact. The configured build root is a
 * deployment-trusted input; every requested file is nevertheless canonicalized
 * and contained so links inside that root cannot reach outside it.
 */
export async function serveStaticFile(
  buildRoot: string,
  pathname: string,
  method: StaticDeliveryMethod = "GET",
): Promise<Response | null> {
  if (method !== "GET" && method !== "HEAD") return null;

  const segments = requestPathSegments(pathname);
  if (!segments) return null;

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(buildRoot);
  } catch {
    return null;
  }

  const resolvedCandidate = resolve(canonicalRoot, ...segments.segments);
  if (!isCanonicalPathContained(canonicalRoot, resolvedCandidate)) return null;

  let canonicalCandidate: string;
  try {
    canonicalCandidate = await realpath(resolvedCandidate);
  } catch {
    return null;
  }
  if (!isCanonicalPathContained(canonicalRoot, canonicalCandidate)) return null;

  let fileSize: number;
  try {
    const candidateStats = await stat(canonicalCandidate);
    if (!candidateStats.isFile()) return null;
    fileSize = candidateStats.size;
  } catch {
    return null;
  }

  const ext = segments.decoded.slice(segments.decoded.lastIndexOf("."));
  const hashed = /-[A-Za-z0-9_]{8,}\.[a-z0-9]+$/.test(segments.decoded);
  const headers: Record<string, string> = {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    "Content-Length": String(fileSize),
    ...STATIC_SECURITY_HEADERS,
  };
  if (ext === ".html") headers["Content-Security-Policy"] = HTML_CONTENT_SECURITY_POLICY;

  return method === "HEAD"
    ? new Response(null, { headers })
    : new Response(Bun.file(canonicalCandidate), { headers });
}
