import { parseDictionary, parseList } from "structured-headers";

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Operation {
  readonly operation_id: string;
  readonly revision: string;
  readonly summary?: string;
  readonly terms: Readonly<Record<string, Json>>;
  readonly expires_at: string;
}
export interface Approval {
  operation_id: string;
  revision: string;
  approver: "agent" | "user";
  approved_at?: number;
  input_type?: string;
  reference?: string;
  /** Both user and agent approvals are assertions by the agent, not merchant-witnessed approval. */
  assurance: "agent-attested";
}
const idPattern = /^[A-Za-z0-9_-]{1,256}$/;
function id(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value);
}
function requireId(value: unknown, label: string): string {
  if (!id(value)) throw new Error(`Invalid ${label}`);
  return value;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function jsonCopy(value: unknown): Json {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value))
    return Object.freeze(value.map(jsonCopy)) as unknown as Json;
  if (
    record(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    const result: Record<string, Json> = Object.create(null);
    for (const [key, item] of Object.entries(value))
      result[key] = jsonCopy(item);
    return Object.freeze(result);
  }
  throw new Error("Terms must be JSON");
}
export function createOperation(input: {
  operation_id: string;
  revision: string;
  summary?: string;
  terms: Record<string, Json>;
  expires_at: string;
}): Operation {
  requireId(input.operation_id, "operation_id");
  requireId(input.revision, "revision");
  if (!record(input.terms)) throw new Error("Invalid terms");
  if (input.summary !== undefined && typeof input.summary !== "string")
    throw new Error("Invalid summary");
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(
      input.expires_at,
    ) ||
    !Number.isFinite(Date.parse(input.expires_at))
  )
    throw new Error("Invalid expires_at");
  return Object.freeze({
    ...input,
    terms: jsonCopy(input.terms) as Readonly<Record<string, Json>>,
  });
}

// Split only at top-level separators. The RFC parser remains responsible for syntax validation.
function splitTop(value: string, delimiter: "," | ";"): string[] {
  const out: string[] = [];
  let start = 0,
    depth = 0,
    quoted = false,
    escaped = false,
    bytes = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (bytes) {
      if (c === ":") bytes = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ":") bytes = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === delimiter && depth === 0) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  out.push(value.slice(start));
  return out;
}
function rejectDuplicateParams(member: string): void {
  const keys = new Set<string>();
  for (const part of splitTop(member, ";").slice(1)) {
    const key = /^\s*([a-z*][a-z0-9_.*-]*)/.exec(part)?.[1];
    if (key && keys.has(key))
      throw new Error("Duplicate structured field parameter");
    if (key) keys.add(key);
  }
}
export function parseExtensions(
  header: string | null,
): ReadonlyMap<string, string> {
  if (header === null) return new Map();
  const members = parseList(header);
  const raw = splitTop(header, ",");
  if (members.length !== raw.length) throw new Error("Invalid extensions");
  const found = new Map<string, string>();
  for (let i = 0; i < members.length; i++) {
    rejectDuplicateParams(raw[i]);
    const [name, params] = members[i];
    if (typeof name !== "string" || typeof params.get("v") !== "string")
      throw new Error("Invalid extension");
    if (found.has(name)) throw new Error("Duplicate extension");
    found.set(name, params.get("v") as string);
  }
  return found;
}
export function operationsNegotiated(
  version: string | null,
  header: string | null,
): boolean {
  if (version !== "1.0") throw new Error("version_unsupported");
  try {
    return parseExtensions(header).get("operations") === "3";
  } catch {
    return false;
  }
}
function approval(input: Record<string, unknown>): Approval {
  const operation_id = requireId(input.operation_id, "operation_id");
  const revision = requireId(input.revision, "revision");
  if (input.approver !== "user" && input.approver !== "agent")
    throw new Error("Invalid approver");
  if (
    input.approved_at !== undefined &&
    (!Number.isSafeInteger(input.approved_at) ||
      typeof input.approved_at !== "number" ||
      Math.abs(input.approved_at) > 999999999999999)
  )
    throw new Error("Invalid approved_at");
  if (input.input_type !== undefined && typeof input.input_type !== "string")
    throw new Error("Invalid input_type");
  if (input.reference !== undefined) requireId(input.reference, "reference");
  return {
    operation_id,
    revision,
    approver: input.approver,
    ...(input.approved_at !== undefined
      ? { approved_at: input.approved_at as number }
      : {}),
    ...(input.approver === "user" && input.input_type !== undefined
      ? { input_type: input.input_type as string }
      : {}),
    ...(input.reference !== undefined
      ? { reference: input.reference as string }
      : {}),
    assurance: "agent-attested",
  };
}
export function parseApprovalHeader(header: string): Approval {
  parseDictionary(header); // validate entire field, including unknown fields
  const parts = splitTop(header, ",");
  const seen = new Set<string>();
  const input: Record<string, unknown> = Object.create(null);
  for (const part of parts) {
    const parsed = parseDictionary(part);
    if (parsed.size !== 1) throw new Error("Invalid approval");
    const [key, item] = [...parsed][0];
    if (seen.has(key)) throw new Error("Duplicate approval member");
    seen.add(key);
    rejectDuplicateParams(part);
    if (
      [
        "operation_id",
        "revision",
        "approver",
        "approved_at",
        "input_type",
        "reference",
      ].includes(key)
    ) {
      if (Array.isArray(item[0])) throw new Error("Invalid approval member");
      if (
        key === "approved_at" &&
        !/^\s*approved_at=-?\d+(?:\s*;|\s*$)/.test(part)
      )
        throw new Error("Invalid approved_at");
      input[key] = item[0];
    }
  }
  return approval(input);
}
export function parseMcpApproval(meta: unknown): Approval | undefined {
  if (!record(meta) || meta["personalagentprotocol.org/approval"] === undefined)
    return undefined;
  const value = meta["personalagentprotocol.org/approval"];
  if (!record(value)) throw new Error("Invalid MCP approval");
  return approval(value);
}
export function approvalRequired(operation: Operation): Response {
  return Response.json(
    { error: "approval_required", operation },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}
export interface Decline {
  operation_id: string;
  revision: string;
  reason?: string;
  alternative?: {
    instructions: string;
    references: { type: "web"; url: string }[];
  };
}
/** Only merchant-approved HTTPS origins may appear in review links. */
export function merchantReviewAlternative(
  url: string,
  allowedOrigin: string,
  instructions: string,
): Decline["alternative"] {
  const target = new URL(url);
  const origin = new URL(allowedOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== allowedOrigin ||
    target.protocol !== "https:" ||
    target.origin !== origin.origin ||
    target.username ||
    target.password
  )
    throw new Error("Unsafe merchant review URL");
  return { instructions, references: [{ type: "web", url: target.href }] };
}
function validateDecline(decline: Decline, allowedOrigin?: string): void {
  requireId(decline.operation_id, "operation_id");
  requireId(decline.revision, "revision");
  if (decline.alternative) {
    if (
      !allowedOrigin ||
      !Array.isArray(decline.alternative.references) ||
      typeof decline.alternative.instructions !== "string"
    )
      throw new Error("Review origin required");
    for (const reference of decline.alternative.references) {
      if (reference.type !== "web") throw new Error("Invalid review reference");
      merchantReviewAlternative(
        reference.url,
        allowedOrigin,
        decline.alternative.instructions,
      );
    }
  }
}
export function approvalDeclined(
  decline: Decline,
  allowedOrigin?: string,
): Response {
  validateDecline(decline, allowedOrigin);
  return Response.json(
    { error: "approval_declined", ...decline },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}
export function mcpApprovalRequired(operation: Operation) {
  return {
    isError: true as const,
    content: [
      { type: "text" as const, text: "Not done yet. This needs approval." },
    ],
    structuredContent: { operation },
  };
}
export function mcpApprovalDeclined(decline: Decline, allowedOrigin?: string) {
  validateDecline(decline, allowedOrigin);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: "The action was not performed." }],
    structuredContent: { error: "approval_declined", ...decline },
  };
}
