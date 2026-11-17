export function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64UrlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return base64UrlEncode(digest);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signValue(
  secret: string,
  payload: string,
): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return `${base64UrlEncode(sig)}.${base64UrlEncode(new TextEncoder().encode(payload))}`;
}

export async function verifySignedValue(
  secret: string,
  token: string,
): Promise<string | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const sigPart = token.slice(0, dot);
  const bodyPart = token.slice(dot + 1);
  let bodyBytes: Uint8Array;
  try {
    const padded = bodyPart.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 ? "=".repeat(4 - (padded.length % 4)) : "";
    const raw = atob(padded + pad);
    bodyBytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  const payload = new TextDecoder().decode(bodyBytes);
  const key = await hmacKey(secret);
  let sigBytes: Uint8Array;
  try {
    const padded = sigPart.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 ? "=".repeat(4 - (padded.length % 4)) : "";
    const raw = atob(padded + pad);
    sigBytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, bodyBytes);
  return ok ? payload : null;
}
