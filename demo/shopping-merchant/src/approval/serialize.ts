import { GuardianTransactionDetailsError } from "./validate.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

function stableJsonInner(value: unknown): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "boolean") return value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new GuardianTransactionDetailsError(
        "invalid_destination",
        "destination contains non-finite number",
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stableJsonInner(entry));
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(key)) {
        throw new GuardianTransactionDetailsError(
          "invalid_destination",
          `destination key "${key}" is not serializable`,
        );
      }
      out[key] = stableJsonInner(value[key]);
    }
    return out;
  }
  throw new GuardianTransactionDetailsError(
    "invalid_destination",
    "destination contains unsupported value type",
  );
}

/** Deterministic JSON for trusted destination payloads; fails on ambiguous types. */
export function stableDestinationJson(
  destination: Record<string, unknown>,
): string {
  return JSON.stringify(stableJsonInner(destination));
}
