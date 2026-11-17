import {
  randomBase64Url,
  signValue,
  verifySignedValue,
} from "./crypto-util.js";
import { secureCookieParts } from "./http.js";
import type { ShoppingLiveEnv } from "./env.js";

export const AGENT_CAPABILITY_COOKIE = "nsh_agent_cap";
export const AGENT_BROWSER_CSRF_HEADER = "x-nominee-agent-browser-csrf";
export const AGENT_CAPABILITY_TTL_MS = 30 * 60 * 1000;

export type AgentCapabilityPayload = {
  customerId: string;
  runId: string;
  secret: string;
};

export async function hashAgentCapabilitySecret(
  customerId: string,
  runId: string,
  secret: string,
): Promise<string> {
  const material = `${customerId}|${runId}|${secret}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function mintAgentCapabilitySecret(): string {
  return randomBase64Url(32);
}

export async function encodeAgentCapabilityCookie(
  env: ShoppingLiveEnv,
  payload: AgentCapabilityPayload,
): Promise<string> {
  const secret = env.SHOPPING_SESSION_SECRET;
  if (!secret) throw new Error("session_secret_missing");
  const signed = await signValue(
    secret,
    JSON.stringify({
      customerId: payload.customerId,
      runId: payload.runId,
      secret: payload.secret,
    }),
  );
  return signed;
}

export async function decodeAgentCapabilityCookie(
  env: ShoppingLiveEnv,
  token: string,
): Promise<AgentCapabilityPayload | null> {
  const secret = env.SHOPPING_SESSION_SECRET;
  if (!secret) return null;
  const json = await verifySignedValue(secret, token);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as AgentCapabilityPayload;
    if (!parsed.customerId || !parsed.runId || !parsed.secret) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function parseAgentCapabilityCookie(req: Request): string | null {
  const match = req.headers
    .get("cookie")
    ?.match(new RegExp(`(?:^|;\\s*)${AGENT_CAPABILITY_COOKIE}=([^;]+)`));
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

const AGENT_BROWSER_CSRF_PURPOSE = "nominee:agent-browser-csrf:v1";

export async function agentBrowserCsrfToken(
  env: ShoppingLiveEnv,
  runId: string,
  secret: string,
): Promise<string> {
  const sessionSecret = env.SHOPPING_SESSION_SECRET;
  if (!sessionSecret) throw new Error("session_secret_missing");
  return signValue(
    sessionSecret,
    JSON.stringify({
      purpose: AGENT_BROWSER_CSRF_PURPOSE,
      runId,
      capSecret: secret,
    }),
  );
}

export async function agentBrowserCsrfMatches(
  env: ShoppingLiveEnv,
  runId: string,
  secret: string,
  header: string | null,
): Promise<boolean> {
  if (!header) return false;
  const expected = await agentBrowserCsrfToken(env, runId, secret);
  return header === expected;
}

export const AGENT_CAPABILITY_COOKIE_PATH = "/api/agent-browser";

export function formatAgentCapabilitySetCookie(
  signedValue: string,
  origin: string,
  maxAgeSec: number,
): string {
  const secure = secureCookieParts(origin);
  return `${AGENT_CAPABILITY_COOKIE}=${encodeURIComponent(signedValue)}; HttpOnly; SameSite=Strict; Path=${AGENT_CAPABILITY_COOKIE_PATH}; Max-Age=${maxAgeSec}${secure}`;
}

export function clearAgentCapabilityCookie(origin: string): string {
  return `${AGENT_CAPABILITY_COOKIE}=; HttpOnly; SameSite=Strict; Path=${AGENT_CAPABILITY_COOKIE_PATH}; Max-Age=0${secureCookieParts(origin)}`;
}
