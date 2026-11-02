// A hostname the app moved away from keeps answering: browser visits get a permanent redirect to
// the same path on CANONICAL_ORIGIN, while API and MCP calls (any non-GET, or a request carrying
// Authorization) are served in place, because clients drop Authorization on a cross-origin redirect.
import type { Env } from "./env.js";

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
