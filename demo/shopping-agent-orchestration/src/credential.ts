import { z } from "zod";

/** Host-minted scoped credential for a single agent run (never log or emit). */
export const agentRunCredential = z
  .object({
    runId: z.string().uuid(),
    ownerId: z.string().min(1).max(200),
    secret: z.string().min(32).max(256),
  })
  .strict();

export type AgentRunCredential = z.infer<typeof agentRunCredential>;

const CREDENTIAL_HEADER = "x-nominee-agent-credential";

export function parseCredentialHeader(header: string | null): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  return trimmed.length ? trimmed : null;
}

/** SHA-256 hex digest of `runId|ownerId|secret` for DO-side verification only. */
export async function hashAgentRunCredential(
  cred: AgentRunCredential,
): Promise<string> {
  const material = `${cred.runId}|${cred.ownerId}|${cred.secret}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function mintAgentRunCredential(ownerId: string): AgentRunCredential {
  const secret = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return {
    runId: crypto.randomUUID(),
    ownerId,
    secret,
  };
}

export function encodeCredentialForHost(cred: AgentRunCredential): string {
  return btoa(JSON.stringify(cred));
}

export function decodeCredentialFromHost(encoded: string): AgentRunCredential {
  const raw = JSON.parse(atob(encoded)) as unknown;
  return agentRunCredential.parse(raw);
}

export { CREDENTIAL_HEADER };