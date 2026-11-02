// A hostname the app moved away from keeps answering: browser visits get a permanent redirect to
// the same path on CANONICAL_ORIGIN, while API and MCP calls (any non-GET, or a request carrying
// Authorization) are served in place, because clients drop Authorization on a cross-origin redirect.
// Machine paths are never redirected, even on an unauthenticated GET: an MCP client that connected to
// the old /mcp reads its protected-resource metadata from the old host and must get a `resource`
// naming that host, not the new one (RFC 9728 §3.3), or it rejects the server.
import type { Env } from "./env.js";

const MACHINE_PATHS = [
  "/.well-known/",
  "/mcp",
  "/v1/",
  "/sandbox/",
  "/healthz",
];

const isMachinePath = (path: string) =>
  MACHINE_PATHS.some((p) =>
    p.endsWith("/")
      ? path.startsWith(p)
      : path === p || path.startsWith(`${p}/`),
  );

export function legacyRedirect(req: Request, env: Env): Response | null {
  const legacy = (env.LEGACY_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (!legacy.length || !env.CANONICAL_ORIGIN) return null;
  const url = new URL(req.url);
  if (!legacy.includes(url.hostname.toLowerCase())) return null;
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  if (req.headers.has("authorization")) return null;
  if (isMachinePath(url.pathname)) return null;
  // Set the path on the canonical URL rather than resolving it: a path like //evil.example would
  // otherwise resolve to another host.
  const to = new URL(env.CANONICAL_ORIGIN);
  to.pathname = url.pathname;
  to.search = url.search;
  return new Response(null, {
    status: 301,
    headers: { location: to.toString(), "cache-control": "max-age=3600" },
  });
}
