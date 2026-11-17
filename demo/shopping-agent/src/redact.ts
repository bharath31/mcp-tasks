const SECRET_PATTERNS = [
  /bearer\s+[a-z0-9._-]+/gi,
  /authorization:\s*\S+/gi,
  /cf-brapi-live-view[^\s]*/gi,
  /password\s*[:=]\s*\S+/gi,
  /api[_-]?key\s*[:=]\s*\S+/gi,
];

export function redactText(input: string, maxLen = 4000): string {
  let out = input.slice(0, maxLen);
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[redacted]");
  }
  return out;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/liveview|live-view|bearer|token|secret|password/i.test(k)) {
        next[k] = "[redacted]";
      } else {
        next[k] = redactValue(v, depth + 1);
      }
    }
    return next;
  }
  return String(value);
}
