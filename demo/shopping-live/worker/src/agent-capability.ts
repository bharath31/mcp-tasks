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

export function agentBrowserCsrfToken(runId: string, secret: string): string {
  return `${runId}.${secret.slice(0, 16)}`;
}

export function agentBrowserCsrfMatches(
  runId: string,
  secret: string,
  header: string | null,
): boolean {
  if (!header) return false;
  return header === agentBrowserCsrfToken(runId, secret);
}

export function formatAgentCapabilitySetCookie(
  signedValue: string,
  origin: string,
  maxAgeSec: number,
): string {
  const secure = secureCookieParts(origin);
  return `${AGENT_CAPABILITY_COOKIE}=${encodeURIComponent(signedValue)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${secure}`;
}

export function clearAgentCapabilityCookie(origin: string): string {
  return `${AGENT_CAPABILITY_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookieParts(origin)}`;
}
