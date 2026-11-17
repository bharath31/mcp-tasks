import type { ShoppingAgentConfig } from "./config.js";
import { merchantHostname, trustedUrl } from "./config.js";

export function assertAllowedNavigation(
  config: ShoppingAgentConfig,
  path: string,
): void {
  if (!config.allowedPaths.includes(path)) {
    throw new ActionRefusedError(
      "navigation_path_denied",
      `Path denied: ${path}`,
    );
  }
}

export function assertTrustedAbsoluteUrl(
  config: ShoppingAgentConfig,
  url: string,
): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ActionRefusedError("invalid_url", "Malformed URL");
  }
  if (parsed.protocol !== "https:") {
    throw new ActionRefusedError(
      "non_https",
      "Only HTTPS merchant URLs are allowed",
    );
  }
  const host = merchantHostname(config);
  if (parsed.hostname !== host) {
    throw new ActionRefusedError(
      "origin_mismatch",
      `Hostname ${parsed.hostname} is not the configured merchant`,
    );
  }
  if (!config.allowedPaths.includes(parsed.pathname || "/")) {
    throw new ActionRefusedError(
      "navigation_path_denied",
      `Path denied: ${parsed.pathname}`,
    );
  }
}

export function buildNavigationUrl(
  config: ShoppingAgentConfig,
  path: string,
  hash?: string,
): string {
  assertAllowedNavigation(config, path);
  const url = trustedUrl(config, path);
  if (!hash) return url;
  if (!/^#[a-z]+$/.test(hash)) {
    throw new ActionRefusedError("invalid_hash", "Invalid fragment");
  }
  return `${url.replace(/\/$/, "")}${hash}`;
}

const AGENT_BROWSER_CART_PATHS = [
  "/api/agent-browser/session",
  "/api/agent-browser/cart",
  "/api/agent-browser/cart/items",
] as const;

/** Defense-in-depth: host-side request URL policy (complements Browser Run guardrails). */
export function shouldAllowBrowserRequest(
  config: ShoppingAgentConfig,
  requestUrl: string,
  opts?: { agentCartApiOnly?: boolean },
): boolean {
  try {
    const u = new URL(requestUrl);
    if (u.protocol !== "https:") return false;
    if (u.hostname !== merchantHostname(config)) return false;
    if (!opts?.agentCartApiOnly) return true;
    if (!u.pathname.startsWith("/api/")) return true;
    return AGENT_BROWSER_CART_PATHS.some(
      (path) => u.pathname === path || u.pathname.startsWith(`${path}/`),
    );
  } catch {
    return false;
  }
}

export class ActionRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ActionRefusedError";
  }
}

export const REQUEST_INTERCEPTION_LIMITS = `Host-side fetch interception only sees navigations and subresources Puppeteer can observe. Browser Run session guardrails (allowedDomains) are the primary network control; they block disallowed hostnames with HTTP 403. They do not substitute for merchant server authorization on POST / checkout APIs, do not inspect WebSocket payloads, and hosts routed via outboundByHost bypass guardrails per Cloudflare docs. This agent never performs checkout POSTs and stops at the UI checkout boundary.`;
