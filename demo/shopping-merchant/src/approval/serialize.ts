import { GuardianTransactionDetailsError } from "./validate.js";

/** Local safety limits for offline destination serialization (not Auth0/vendor limits). */
export const DESTINATION_JSON_MAX_DEPTH = 32;
export const DESTINATION_JSON_MAX_NODES = 2_000;
export const DESTINATION_JSON_MAX_OUTPUT_CHARS = 64_000;

type SerializeContext = {
  depth: number;
  nodeCount: number;
  seen: WeakSet<object>;
  outputChars: number;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

function bumpNodeCount(ctx: SerializeContext): void {
  ctx.nodeCount += 1;
  if (ctx.nodeCount > DESTINATION_JSON_MAX_NODES) {
    throw new GuardianTransactionDetailsError(
      "invalid_destination",
      `destination exceeds local node limit (${DESTINATION_JSON_MAX_NODES})`,
    );
  }
}

function recordOutputChars(ctx: SerializeContext, added: number): void {
  ctx.outputChars += added;
  if (ctx.outputChars > DESTINATION_JSON_MAX_OUTPUT_CHARS) {
    throw new GuardianTransactionDetailsError(
      "invalid_destination",
      `destination exceeds local serialized size limit (${DESTINATION_JSON_MAX_OUTPUT_CHARS})`,
    );
  }
}

function stableJsonInner(value: unknown, ctx: SerializeContext): unknown {
  bumpNodeCount(ctx);

  if (value === null) return null;
  if (typeof value === "string") {
    recordOutputChars(ctx, value.length + 2);
    return value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new GuardianTransactionDetailsError(
        "invalid_destination",
        "destination contains non-finite number",
      );
    }
    return value;
  }
  if (
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    typeof value === "function" ||
    typeof value === "undefined"
  ) {
    throw new GuardianTransactionDetailsError(
      "invalid_destination",
      "destination contains unsupported value type",
    );
  }

  if (Array.isArray(value)) {
    if (ctx.seen.has(value)) {
      throw new GuardianTransactionDetailsError(
        "invalid_destination",
        "destination contains cyclic reference",
      );
    }
    if (ctx.depth >= DESTINATION_JSON_MAX_DEPTH) {
      throw new GuardianTransactionDetailsError(
        "invalid_destination",
        `destination exceeds local depth limit (${DESTINATION_JSON_MAX_DEPTH})`,
      );
    }
    ctx.seen.add(value);
    const nextCtx = { ...ctx, depth: ctx.depth + 1 };
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i += 1) {
      if (!(i in value)) {
        throw new GuardianTransactionDetailsError(
          "invalid_destination",
          "destination array must not contain sparse slots",
        );
      }
      out.push(stableJsonInner(value[i], nextCtx));
    }
    ctx.seen.delete(value);
    recordOutputChars(ctx, out.length * 2);
    return out;
  }

  if (isPlainObject(value)) {
    if (ctx.seen.has(value)) {
      throw new GuardianTransactionDetailsError(
        "invalid_destination",
        "destination contains cyclic reference",
      );
    }
    if (ctx.depth >= DESTINATION_JSON_MAX_DEPTH) {
      throw new GuardianTransactionDetailsError(
        "invalid_destination",
        `destination exceeds local depth limit (${DESTINATION_JSON_MAX_DEPTH})`,
      );
    }
    ctx.seen.add(value);
    const nextCtx = { ...ctx, depth: ctx.depth + 1 };
    const keys = Object.getOwnPropertyNames(value).sort();
    for (const key of Object.getOwnPropertySymbols(value)) {
      throw new GuardianTransactionDetailsError(
        "invalid_destination",
        "destination must not contain symbol keys",
      );
    }
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(key)) {
        throw new GuardianTransactionDetailsError(
          "invalid_destination",
          `destination key "${key}" is not serializable`,
        );
      }
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc) continue;
      if (desc.get !== undefined || desc.set !== undefined) {
        throw new GuardianTransactionDetailsError(
          "invalid_destination",
          `destination key "${key}" must not use accessors`,
        );
      }
      out[key] = stableJsonInner(desc.value, nextCtx);
    }
    ctx.seen.delete(value);
    recordOutputChars(ctx, keys.length * 8);
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
  const ctx: SerializeContext = {
    depth: 0,
    nodeCount: 0,
    seen: new WeakSet(),
    outputChars: 0,
  };
  const normalized = stableJsonInner(destination, ctx);
  const json = JSON.stringify(normalized);
  if (json.length > DESTINATION_JSON_MAX_OUTPUT_CHARS) {
    throw new GuardianTransactionDetailsError(
      "invalid_destination",
      `destination exceeds local serialized size limit (${DESTINATION_JSON_MAX_OUTPUT_CHARS})`,
    );
  }
  return json;
}
