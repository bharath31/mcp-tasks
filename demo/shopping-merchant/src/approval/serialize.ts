import { GuardianTransactionDetailsError } from "./validate.js";

/** Local safety limits for offline destination serialization (not Auth0/vendor limits). */
export const DESTINATION_JSON_MAX_DEPTH = 32;
export const DESTINATION_JSON_MAX_NODES = 2_000;
export const DESTINATION_JSON_MAX_OUTPUT_CHARS = 64_000;

type SerializeBudget = {
  nodeCount: number;
  outputChars: number;
};

type SerializeContext = {
  depth: number;
  budget: SerializeBudget;
  seen: WeakSet<object>;
};

function childContext(ctx: SerializeContext): SerializeContext {
  return { depth: ctx.depth + 1, budget: ctx.budget, seen: ctx.seen };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

function hasSerializableToJsonSurprise(value: object): boolean {
  let current: object | null = value;
  while (current !== null) {
    const desc = Object.getOwnPropertyDescriptor(current, "toJSON");
    if (desc) {
      if (desc.get !== undefined || desc.set !== undefined) {
        return true;
      }
      if (typeof desc.value === "function") {
        return true;
      }
    }
    current = Object.getPrototypeOf(current);
  }
  return false;
}

function isCanonicalArrayIndexKey(key: string, length: number): boolean {
  if (key === "length") return true;
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return false;
  return Number(key) < length;
}

function assertDataProperty(
  desc: PropertyDescriptor | undefined,
  kind: "object" | "array",
  label: string,
): asserts desc is PropertyDescriptor & { value: unknown } {
  if (!desc) {
    throw new GuardianTransactionDetailsError(
      "invalid_destination",
      `destination ${kind} property "${label}" is missing`,
    );
  }
  if (desc.get !== undefined || desc.set !== undefined) {
    throw new GuardianTransactionDetailsError(
      "invalid_destination",
      `destination ${kind} property "${label}" must not use accessors`,
    );
  }
}

function bumpNodeCount(ctx: SerializeContext): void {
  ctx.budget.nodeCount += 1;
  if (ctx.budget.nodeCount > DESTINATION_JSON_MAX_NODES) {
    throw new GuardianTransactionDetailsError(
      "invalid_destination",
      `destination exceeds local node limit (${DESTINATION_JSON_MAX_NODES})`,
    );
  }
}

function recordOutputChars(ctx: SerializeContext, added: number): void {
  ctx.budget.outputChars += added;
  if (ctx.budget.outputChars > DESTINATION_JSON_MAX_OUTPUT_CHARS) {
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
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new GuardianTransactionDetailsError(
        "invalid_destination",
        "destination array must use the standard Array prototype",
      );
    }
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
    const nextCtx = childContext(ctx);
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const key = String(i);
      if (!Object.hasOwn(value, key)) {
        throw new GuardianTransactionDetailsError(
          "invalid_destination",
          "destination array must not contain sparse slots or inherited indices",
        );
      }
      const desc = Object.getOwnPropertyDescriptor(value, key);
      assertDataProperty(desc, "array", key);
      out.push(stableJsonInner(desc.value, nextCtx));
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      if (isCanonicalArrayIndexKey(key, value.length)) continue;
      throw new GuardianTransactionDetailsError(
        "invalid_destination",
        `destination array must not contain non-index property "${key}"`,
      );
    }
    for (const sym of Object.getOwnPropertySymbols(value)) {
      throw new GuardianTransactionDetailsError(
        "invalid_destination",
        "destination array must not contain symbol keys",
      );
    }
    ctx.seen.delete(value);
    recordOutputChars(ctx, out.length * 2);
    return out;
  }

  if (isPlainObject(value)) {
    if (hasSerializableToJsonSurprise(value)) {
      throw new GuardianTransactionDetailsError(
        "invalid_destination",
        "destination must not define toJSON",
      );
    }
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
    const nextCtx = childContext(ctx);
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
      assertDataProperty(desc, "object", key);
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
  const budget: SerializeBudget = {
    nodeCount: 0,
    outputChars: 0,
  };
  const ctx: SerializeContext = {
    depth: 0,
    budget,
    seen: new WeakSet(),
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
