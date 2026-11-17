const SECRET_PATTERNS = [
  /bearer\s+[a-z0-9._-]+/gi,
  /authorization:\s*\S+/gi,
  /cf-brapi-live-view[^\s]*/gi,
  /password\s*[:=]\s*\S+/gi,
  /api[_-]?key\s*[:=]\s*\S+/gi,
];

const FORBIDDEN_IN_PUBLIC =
  /bearer|authorization:|cf-brapi-live-view|api[_-]?key|password/i;

function patternRedact(input: string, maxLen: number): string {
  let out = input.slice(0, maxLen);
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[redacted]");
  }
  return out;
}

/** Pattern redaction plus scrubbing of known credential material (not pattern-only). */
export function sanitizePublicText(
  input: string,
  maxLen: number,
  knownSecrets: readonly string[] = [],
): string {
  let out = patternRedact(input, maxLen);
  for (const secret of knownSecrets) {
    if (secret.length >= 8 && out.includes(secret)) {
      out = out.split(secret).join("[redacted]");
    }
  }
  if (FORBIDDEN_IN_PUBLIC.test(out)) {
    return "[redacted]";
  }
  return out;
}

export function assertPublicBlobSafe(blob: string): void {
  if (FORBIDDEN_IN_PUBLIC.test(blob)) {
    throw new Error("public_run_leak");
  }
  for (const marker of ["credentialDigest"]) {
    if (blob.includes(marker)) {
      throw new Error("public_run_leak");
    }
  }
}