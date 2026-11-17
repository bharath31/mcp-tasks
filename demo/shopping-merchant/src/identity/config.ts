/** Worker env keys for Auth0-backed shopping customer identity (unwired until bound). */
export type ShoppingIdentityEnv = {
  SHOPPING_AUTH0_DOMAIN: string;
  SHOPPING_API_AUDIENCE: string;
};

export const SHOPPING_CUSTOMER_SCOPE = "shopping:customer";

const MAX_DNS_NAME_LEN = 253;
const LABEL_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const MAX_AUDIENCE_LEN = 2048;

/**
 * **Trust boundary (operational):** JWT verification trusts whatever
 * `SHOPPING_AUTH0_DOMAIN` and `SHOPPING_API_AUDIENCE` the Worker operator configures.
 * Hostname syntax checks block URL/port/path/userinfo foot-guns and whitespace skew; they
 * do **not** prevent pinning an attacker's legitimate Auth0 tenant if bindings are wrong.
 * Suffix or pattern allow-lists are not a substitute for secure deploy and secret management.
 */
export const shoppingIssuer = (domain: string) =>
  `https://${domain.replace(/\/+$/, "")}/`;

function isIpv4Host(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

function isLocalhostHost(host: string): boolean {
  const lower = host.toLowerCase();
  return lower === "localhost" || lower.endsWith(".localhost");
}

function isDnsHostname(host: string): boolean {
  if (host.length === 0 || host.length > MAX_DNS_NAME_LEN) return false;
  if (host.endsWith(".")) return false;
  const labels = host.split(".");
  if (labels.some((label) => label.length === 0)) return false;
  return labels.every((label) => LABEL_RE.test(label));
}

/**
 * Accepts a bare DNS hostname only (Auth0 tenant domain or custom domain).
 * Rejects schemes, paths, ports, userinfo, whitespace, localhost, and IP literals.
 */
export function parseAuth0Domain(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (/[:/\\?#@]/.test(trimmed)) return null;
  if (isLocalhostHost(trimmed) || isIpv4Host(trimmed)) return null;
  if (!isDnsHostname(trimmed)) return null;
  return trimmed;
}

/** Audience identifier: nonempty, bounded length, no whitespace; URL forms must parse cleanly. */
export function parseApiAudience(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.length > MAX_AUDIENCE_LEN) {
    return null;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.username || url.password) return null;
    } catch {
      return null;
    }
  }
  return trimmed;
}

export function normalizeShoppingIdentity(
  env: Partial<ShoppingIdentityEnv>,
): ShoppingIdentityEnv | null {
  const domain = parseAuth0Domain(env.SHOPPING_AUTH0_DOMAIN);
  const audience = parseApiAudience(env.SHOPPING_API_AUDIENCE);
  if (!domain || !audience) return null;
  return {
    SHOPPING_AUTH0_DOMAIN: domain,
    SHOPPING_API_AUDIENCE: audience,
  };
}

export function shoppingIdentityConfigured(
  env: Partial<ShoppingIdentityEnv>,
): env is ShoppingIdentityEnv {
  return normalizeShoppingIdentity(env) !== null;
}

export function requireShoppingIdentity(
  env: Partial<ShoppingIdentityEnv>,
): ShoppingIdentityEnv {
  const normalized = normalizeShoppingIdentity(env);
  if (!normalized) {
    throw new Error("shopping_identity_unconfigured");
  }
  return normalized;
}
