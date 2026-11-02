import { z } from "zod";
import { audit } from "./audit.js";
import { requirePermission } from "./authn.js";
import { actorOf, type Ctx } from "./context.js";
import { ServiceError } from "./errors.js";
import { iso, type Db, type OperationRow } from "./store.js";

const duration = z.string().regex(/^\d+(s|m|h|d)$/);
const budgetSchema = z
  .object({
    per: z.enum(["delegation", "principal", "organization"]),
    window: duration,
    max_amount_minor: z.number().int().safe().nonnegative().optional(),
    /** Declared `int` argument carrying the amount in minor units; defaults to amount_minor/amountMinor. */
    amount_arg: z.string().min(1).max(100).optional(),
    max_count: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (v) => v.max_amount_minor !== undefined || v.max_count !== undefined,
    "Budget needs an amount or count limit",
  );
const outcomeSchema = z.union([
  z
    .object({ allow: z.object({ budget: budgetSchema.optional() }).strict() })
    .strict(),
  z
    .object({
      deny: z.union([
        z.boolean(),
        z.object({ reason: z.string().max(200).optional() }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      approve: z
        .object({
          tier: z.string(),
          quorum: z.number().int().min(1).max(2).optional(),
          ttl: duration.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      step_up: z
        .object({
          acr: z.string().min(1),
          max_age: z.number().int().positive(),
        })
        .strict(),
    })
    .strict(),
]);
const tierSchema = z
  .object({
    assurance: z.enum(["session_mfa", "per_operation"]),
    max_age: z.number().int().positive().optional(),
    dpop: z.enum(["required", "optional"]).optional(),
    /** Session reviewers idle longer than this must re-authenticate (default 15m). */
    idle_timeout: duration.optional(),
    factors: z.array(z.string()).max(10).optional(),
    batch_max: z.number().int().min(1).max(5).optional(),
    velocity_per_hour: z.number().int().positive().optional(),
  })
  .strict();
export const policySchema = z
  .object({
    resource_server: z.string().min(1).max(200),
    version: z.string().min(1).max(100),
    budget_hold_ttl: duration.optional(),
    unknown_action: z.enum(["deny", "approve"]).default("deny"),
    unknown_action_approvers: z
      .object({ relation: z.string().min(1), on: z.literal("organization") })
      .strict()
      .optional(),
    unknown_action_requester_relation: z.string().min(1).optional(),
    actions: z.record(
      z.string(),
      z
        .object({
          arguments: z.record(
            z.string(),
            z.enum(["int", "string", "bool", "double", "list", "map"]),
          ),
          approvers: z
            .object({
              relation: z.string().min(1),
              on: z.literal("organization"),
            })
            .strict(),
          requester_relation: z.string().min(1).optional(),
          /**
           * "owner": the user who owns an agent's delegation may approve that agent's
           * operations themselves, always with a fresh per-operation step-up bound to the
           * digest. Applies only to single-approver decisions. Default "deny" (four-eyes).
           */
          self_approval: z.enum(["deny", "owner"]).optional(),
          rules: z
            .array(
              z
                .object({
                  id: z.string().min(1).max(100),
                  when: z.string().min(1).max(4000),
                  then: outcomeSchema,
                })
                .strict(),
            )
            .max(100),
          default: outcomeSchema,
        })
        .strict(),
    ),
    tiers: z.record(z.string(), tierSchema),
  })
  .strict();
export type PolicyDocument = z.infer<typeof policySchema>;
export type PolicyActor = {
  type: "agent" | "human" | "service";
  id: string;
  act?: Record<string, unknown> | null;
  sub_profile?: unknown;
};
export type PolicyDecision = {
  decision: "allow" | "step_up_required" | "approval_required" | "deny";
  reasonCode: string;
  policyVersion: string | null;
  ruleIds: string[];
  tier?: string;
  assurance?: z.infer<typeof tierSchema>;
  quorum?: number;
  ttl?: string;
  stepUp?: { acr: string; max_age: number };
  budgetRuleIds: string[];
  approverRelation?: string;
  requesterRelation?: string;
  relationInputs?: Record<string, boolean>;
  /** Snapshot of the action's self_approval setting at registration. */
  selfApproval?: "owner";
};
type Node =
  | { kind: "literal"; value: unknown }
  | { kind: "path"; path: string[] }
  | { kind: "unary"; op: string; right: Node }
  | { kind: "binary"; op: string; left: Node; right: Node }
  | { kind: "list"; values: Node[] };
type Token = { value: string; literal?: unknown; isLiteral?: boolean };
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const precedence: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  in: 3,
  ">": 4,
  ">=": 4,
  "<": 4,
  "<=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};
function invalid(message: string): never {
  throw new ServiceError("invalid_request", message);
}
/** Deliberately constrained CEL: expressions, scalar operators and membership;
 * no macros, function calls, dynamic code execution or unbounded iteration. */
export function compileCondition(
  source: string,
  args: Record<string, string>,
): Node {
  const tokens: Token[] = [];
  let rest = source;
  while (rest.trim()) {
    rest = rest.trimStart();
    const s = rest.match(/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/);
    const n = rest.match(/^\d+(?:\.\d+)?/);
    const ident = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    const op = rest.match(/^(\|\||&&|==|!=|>=|<=|[!><+*/%().,\[\]-])/);
    if (s) {
      let value: string;
      try {
        value =
          s[0][0] === '"'
            ? JSON.parse(s[0])
            : s[0].slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
      } catch {
        return invalid("Invalid CEL string literal.");
      }
      tokens.push({ value: s[0], literal: value, isLiteral: true });
      rest = rest.slice(s[0].length);
    } else if (n) {
      tokens.push({ value: n[0], literal: Number(n[0]), isLiteral: true });
      rest = rest.slice(n[0].length);
    } else if (ident) {
      const v = ident[0];
      tokens.push(
        ["true", "false", "null"].includes(v)
          ? {
              value: v,
              isLiteral: true,
              literal: v === "null" ? null : v === "true",
            }
          : { value: v },
      );
      rest = rest.slice(v.length);
    } else if (op) {
      tokens.push({ value: op[0] });
      rest = rest.slice(op[0].length);
    } else return invalid("Unsupported CEL syntax.");
    if (tokens.length > 512)
      return invalid("CEL expression exceeds the instruction limit.");
  }
  let at = 0;
  const take = (expected: string) => {
    if (tokens[at++]?.value !== expected)
      invalid(`Expected '${expected}' in CEL expression.`);
  };
  const parse = (min = 0, depth = 0): Node => {
    if (depth > 40) return invalid("CEL nesting limit exceeded.");
    const t = tokens[at++];
    if (!t) return invalid("Incomplete CEL expression.");
    let left: Node;
    if (t.isLiteral) left = { kind: "literal", value: t.literal };
    else if (t.value === "!" || t.value === "-")
      left = { kind: "unary", op: t.value, right: parse(7, depth + 1) };
    else if (t.value === "(") {
      left = parse(0, depth + 1);
      take(")");
    } else if (t.value === "[") {
      const values: Node[] = [];
      if (tokens[at]?.value !== "]") {
        do {
          values.push(parse(0, depth + 1));
          if (tokens[at]?.value !== ",") break;
          at++;
        } while (true);
      }
      take("]");
      left = { kind: "list", values };
    } else {
      const path = [t.value];
      while (tokens[at]?.value === ".") {
        at++;
        const next = tokens[at++]?.value;
        if (!next || !/^[A-Za-z_]\w*$/.test(next))
          return invalid("Invalid CEL field.");
        path.push(next);
      }
      if (path.some((p) => forbidden.has(p)))
        return invalid("Forbidden CEL field.");
      if (
        ![
          "action",
          "resource",
          "args",
          "facts",
          "actor",
          "relations",
          "aggregates",
        ].includes(path[0]!)
      )
        return invalid(`Undeclared CEL input: ${path[0]}.`);
      if (
        path[0] === "args" &&
        (path.length !== 2 || !Object.hasOwn(args, path[1]!))
      )
        return invalid(`Undeclared argument: ${path.slice(1).join(".")}.`);
      if (
        path[0] === "actor" &&
        !["type", "id", "act", "sub_profile"].includes(path[1]!)
      )
        return invalid("Undeclared actor field.");
      left = { kind: "path", path };
    }
    while (at < tokens.length && (precedence[tokens[at]!.value] ?? -1) >= min) {
      const op = tokens[at++]!.value;
      const right = parse(precedence[op]! + 1, depth + 1);
      left = { kind: "binary", op, left, right };
    }
    return left;
  };
  const tree = parse();
  if (at !== tokens.length)
    invalid("Unexpected CEL token or unsupported function call.");
  const type = (n: Node): string => {
    if (n.kind === "literal") return typeof n.value;
    if (n.kind === "list") {
      n.values.forEach(type);
      return "list";
    }
    if (n.kind === "path") {
      if (n.path[0] === "args")
        return (
          (
            { int: "number", double: "number", bool: "boolean" } as Record<
              string,
              string
            >
          )[args[n.path[1]!]!] ?? args[n.path[1]!]!
        );
      return ["action", "resource"].includes(n.path[0]!) ||
        (n.path[0] === "actor" && ["type", "id"].includes(n.path[1]!))
        ? "string"
        : "dynamic";
    }
    if (n.kind === "unary") {
      const r = type(n.right);
      const expected = n.op === "!" ? "boolean" : "number";
      if (r !== "dynamic" && r !== expected)
        invalid("Invalid CEL unary operand type.");
      return expected;
    }
    const l = type(n.left),
      r = type(n.right);
    if (
      ["==", "!="].includes(n.op) &&
      l !== "dynamic" &&
      r !== "dynamic" &&
      l !== r
    )
      invalid("CEL equality operand types differ.");
    if (n.op === "in" && r !== "list" && r !== "dynamic")
      invalid("CEL membership requires a list.");
    if (
      ["&&", "||"].includes(n.op) &&
      [l, r].some((t) => !["boolean", "dynamic"].includes(t))
    )
      invalid("CEL logical operators require booleans.");
    if (
      [">", ">=", "<", "<="].includes(n.op) &&
      l !== "dynamic" &&
      r !== "dynamic" &&
      (l !== r || !["number", "string"].includes(l))
    )
      invalid("CEL comparison operand types differ.");
    if (
      ["+", "-", "*", "/", "%"].includes(n.op) &&
      [l, r].some((t) => !["number", "dynamic"].includes(t))
    )
      invalid("CEL arithmetic requires numbers.");
    return ["+", "-", "*", "/", "%"].includes(n.op) ? "number" : "boolean";
  };
  if (!["boolean", "dynamic"].includes(type(tree)))
    invalid("CEL condition must produce a boolean.");
  return tree;
}
export function evaluateCondition(
  tree: Node,
  inputs: Record<string, unknown>,
): boolean {
  let steps = 0;
  const run = (n: Node): any => {
    if (++steps > 1024) throw new Error("CEL instruction limit");
    if (n.kind === "literal") return n.value;
    if (n.kind === "list") return n.values.map(run);
    if (n.kind === "path")
      return n.path.reduce<unknown>((v, k) => {
        if (!v || typeof v !== "object" || !Object.hasOwn(v, k))
          throw new Error(`Missing CEL value ${n.path.join(".")}`);
        return (v as Record<string, unknown>)[k];
      }, inputs);
    if (n.kind === "unary") {
      const r = run(n.right);
      if (n.op === "!") {
        if (typeof r !== "boolean") throw new Error("CEL boolean required");
        return !r;
      }
      if (typeof r !== "number") throw new Error("CEL number required");
      return -r;
    }
    const l = run(n.left);
    if (n.op === "&&" || n.op === "||") {
      if (typeof l !== "boolean") throw new Error("CEL boolean required");
      if (n.op === "&&" && !l) return false;
      if (n.op === "||" && l) return true;
      const r = run(n.right);
      if (typeof r !== "boolean") throw new Error("CEL boolean required");
      return r;
    }
    const r = run(n.right);
    if (n.op === "in") {
      if (!Array.isArray(r)) throw new Error("CEL list required");
      return r.includes(l);
    }
    if (n.op === "==") return l === r;
    if (n.op === "!=") return l !== r;
    if (typeof l !== typeof r || !["number", "string"].includes(typeof l))
      throw new Error("CEL incompatible operands");
    if (n.op === ">") return l > r;
    if (n.op === ">=") return l >= r;
    if (n.op === "<") return l < r;
    if (n.op === "<=") return l <= r;
    if (typeof l !== "number") throw new Error("CEL number required");
    const result =
      n.op === "+"
        ? l + r
        : n.op === "-"
          ? l - r
          : n.op === "*"
            ? l * r
            : n.op === "/"
              ? Number.isInteger(l) && Number.isInteger(r)
                ? Math.trunc(l / r)
                : l / r
              : l % r;
    if (
      !Number.isFinite(result) ||
      (Number.isInteger(l) &&
        Number.isInteger(r) &&
        !Number.isSafeInteger(result))
    )
      throw new Error("CEL arithmetic error");
    return result;
  };
  const result = run(tree);
  if (typeof result !== "boolean")
    throw new Error("CEL condition must be boolean");
  return result;
}
export function milliseconds(value: string): number {
  const m = value.match(/^(\d+)(s|m|h|d)$/);
  if (!m) return invalid("Invalid policy duration.");
  const result =
    Number(m[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]!]!;
  if (!Number.isSafeInteger(result) || result <= 0 || result > 365 * 86400000)
    invalid("Policy duration must be positive and at most 365 days.");
  return result;
}
/** The declared integer argument a budget's amount limit counts, or null when none is declared. */
export function budgetAmountArgument(
  budget: z.infer<typeof budgetSchema>,
  declared: Record<string, string>,
): string | null {
  const name =
    budget.amount_arg ??
    ["amount_minor", "amountMinor"].find((n) => declared[n] === "int");
  return name && declared[name] === "int" ? name : null;
}
export function validatePolicy(document: unknown): PolicyDocument {
  const result = policySchema.safeParse(document);
  if (!result.success) return invalid(result.error.message);
  const p = result.data;
  if (
    p.unknown_action === "approve" &&
    (!p.tiers.routine || !p.unknown_action_approvers)
  )
    invalid(
      "unknown_action approve requires a routine tier and explicit unknown_action_approvers.",
    );
  if (p.budget_hold_ttl) milliseconds(p.budget_hold_ttl);
  for (const tier of Object.values(p.tiers))
    if (tier.idle_timeout) milliseconds(tier.idle_timeout);
  for (const action of Object.values(p.actions)) {
    const ids = new Set<string>();
    for (const rule of action.rules) {
      if (ids.has(rule.id)) invalid(`Duplicate rule id ${rule.id}.`);
      ids.add(rule.id);
      compileCondition(rule.when, action.arguments);
    }
    for (const outcome of [
      ...action.rules.map((r) => r.then),
      action.default,
    ]) {
      if ("approve" in outcome && !p.tiers[outcome.approve.tier])
        invalid(`Undefined tier ${outcome.approve.tier}.`);
      if ("approve" in outcome && outcome.approve.ttl)
        milliseconds(outcome.approve.ttl);
      if ("allow" in outcome && outcome.allow.budget) {
        const budget = outcome.allow.budget;
        milliseconds(budget.window);
        if (
          budget.max_amount_minor !== undefined &&
          !budgetAmountArgument(budget, action.arguments)
        )
          invalid(
            "A budget with max_amount_minor needs amount_arg naming a declared int argument (or a declared int amount_minor/amountMinor).",
          );
      }
    }
    // Exhausting a budget drops its rule, so the default decides (PRD 7.3). A bare allow default
    // would turn "over budget" into "unbudgeted allow".
    if (
      "allow" in action.default &&
      !action.default.allow.budget &&
      action.rules.some((r) => "allow" in r.then && r.then.allow.budget)
    )
      invalid(
        "An action with a budgeted allow rule needs a default that is not an unbudgeted allow.",
      );
  }
  return p;
}
function base(
  p: PolicyDocument | null,
  decision: PolicyDecision["decision"],
  reasonCode: string,
): PolicyDecision {
  return {
    decision,
    reasonCode,
    policyVersion: p?.version ?? null,
    ruleIds: [],
    budgetRuleIds: [],
  };
}
const conditionCache = new Map<
  string,
  { when: string; args: string; tree: Node }
>();
const cacheStats = { hits: 0, misses: 0 };
export const conditionCacheStats = () => ({ ...cacheStats });
/** Compiled conditions are cached per (policy version, action, rule id); a changed
 * expression or argument schema under the same key recompiles rather than going stale. */
function compiledCondition(
  p: PolicyDocument,
  actionName: string,
  ruleId: string,
  when: string,
  args: Record<string, string>,
): Node {
  const key = `${p.resource_server}\0${p.version}\0${actionName}\0${ruleId}`;
  const signature = JSON.stringify(args);
  const hit = conditionCache.get(key);
  if (hit && hit.when === when && hit.args === signature) {
    cacheStats.hits++;
    return hit.tree;
  }
  cacheStats.misses++;
  const tree = compileCondition(when, args);
  if (conditionCache.size >= 5000) conditionCache.clear();
  conditionCache.set(key, { when, args: signature, tree });
  return tree;
}
const rank = { allow: 0, step_up_required: 1, approval_required: 2, deny: 3 };
export function evaluatePolicy(
  p: PolicyDocument | null,
  actionName: string,
  inputs: Record<string, unknown>,
  exhausted = new Set<string>(),
): PolicyDecision {
  if (!p) return base(p, "deny", "policy_not_configured");
  const action = p.actions[actionName];
  if (!action)
    return p.unknown_action === "approve" && p.tiers.routine
      ? {
          ...base(p, "approval_required", "unknown_action_requires_approval"),
          tier: "routine",
          assurance: p.tiers.routine,
          quorum: 1,
          approverRelation: p.unknown_action_approvers?.relation,
          requesterRelation: p.unknown_action_requester_relation ?? "member",
        }
      : base(p, "deny", "unknown_action");
  try {
    const args = inputs.args as Record<string, unknown>;
    for (const [name, type] of Object.entries(action.arguments)) {
      const value = args[name];
      const ok =
        type === "int"
          ? Number.isSafeInteger(value)
          : type === "double"
            ? typeof value === "number" && Number.isFinite(value)
            : type === "bool"
              ? typeof value === "boolean"
              : type === "list"
                ? Array.isArray(value)
                : type === "map"
                  ? value !== null &&
                    typeof value === "object" &&
                    !Array.isArray(value)
                  : typeof value === "string";
      if (!ok) throw new Error(`Invalid argument ${name}`);
    }
    const fired = action.rules.filter((r) =>
      evaluateCondition(
        compiledCondition(p, actionName, r.id, r.when, action.arguments),
        inputs,
      ),
    );
    const matched = fired.filter(
      (r) => !("allow" in r.then && r.then.allow.budget && exhausted.has(r.id)),
    );
    if (
      !matched.length &&
      "allow" in action.default &&
      ((action.default.allow.budget && exhausted.has("default")) ||
        // Stored versions predating the publish check: an over-budget request never becomes a plain allow.
        (!action.default.allow.budget && fired.length > matched.length))
    )
      return base(p, "deny", "budget_exhausted");
    const outcomes = matched.length
      ? matched.map((r) => ({ id: r.id, value: r.then }))
      : [{ id: "default", value: action.default }];
    let result = base(p, "allow", "policy_allowed");
    for (const { id, value } of outcomes) {
      const next: PolicyDecision =
        "deny" in value
          ? base(
              p,
              "deny",
              typeof value.deny === "object"
                ? (value.deny.reason ?? "policy_denied")
                : "policy_denied",
            )
          : "approve" in value
            ? {
                ...base(p, "approval_required", "policy_approval_required"),
                tier: value.approve.tier,
                assurance: p.tiers[value.approve.tier],
                quorum: value.approve.quorum ?? 1,
                ttl: value.approve.ttl,
              }
            : "step_up" in value
              ? {
                  ...base(
                    p,
                    "step_up_required",
                    "insufficient_user_authentication",
                  ),
                  stepUp: value.step_up,
                }
              : base(p, "allow", "policy_allowed");
      if ("allow" in value && value.allow.budget) result.budgetRuleIds.push(id);
      const previous = result;
      const priorIds = result.ruleIds;
      const budgets = result.budgetRuleIds;
      const strongerTier =
        next.decision === "approval_required" &&
        result.decision === "approval_required" &&
        ((next.assurance?.assurance === "per_operation" &&
          result.assurance?.assurance !== "per_operation") ||
          (next.quorum ?? 1) > (result.quorum ?? 1));
      if (rank[next.decision] > rank[result.decision] || strongerTier) {
        if (
          next.decision === "approval_required" &&
          result.assurance?.assurance === "per_operation" &&
          next.assurance?.assurance !== "per_operation"
        ) {
          next.tier = result.tier;
          next.assurance = result.assurance;
        }
        result = {
          ...next,
          ruleIds: priorIds,
          budgetRuleIds: budgets,
          quorum:
            next.decision === "approval_required"
              ? Math.max(next.quorum ?? 1, result.quorum ?? 1)
              : undefined,
        };
      }
      if (
        next.decision === "approval_required" &&
        previous.decision === "approval_required"
      ) {
        const a = previous.assurance,
          b = next.assurance;
        if (a && b && result.assurance)
          result.assurance = {
            ...result.assurance,
            max_age:
              Math.min(a.max_age ?? Infinity, b.max_age ?? Infinity) ===
              Infinity
                ? undefined
                : Math.min(a.max_age ?? Infinity, b.max_age ?? Infinity),
            dpop:
              a.dpop === "required" || b.dpop === "required"
                ? "required"
                : result.assurance.dpop,
            idle_timeout: [a.idle_timeout, b.idle_timeout]
              .filter((v): v is string => Boolean(v))
              .sort((x, y) => milliseconds(x) - milliseconds(y))[0],
            // Either rule's factor list is acceptable evidence only if both accept it.
            factors:
              a.factors && b.factors
                ? a.factors.filter((f) => b.factors!.includes(f))
                : (a.factors ?? b.factors),
            velocity_per_hour: Math.min(
              a.velocity_per_hour ?? 60,
              b.velocity_per_hour ?? 60,
            ),
            batch_max: Math.min(a.batch_max ?? 5, b.batch_max ?? 5),
          };
        result.quorum = Math.max(previous.quorum ?? 1, next.quorum ?? 1);
        const ttl = Math.min(
          previous.ttl ? milliseconds(previous.ttl) : Infinity,
          next.ttl ? milliseconds(next.ttl) : Infinity,
        );
        if (Number.isFinite(ttl)) result.ttl = `${ttl / 1000}s`;
      }
      if (next.stepUp && result.stepUp)
        result.stepUp = {
          acr: [
            ...new Set([
              ...result.stepUp.acr.split(" "),
              ...next.stepUp.acr.split(" "),
            ]),
          ]
            .sort()
            .join(" "),
          max_age: Math.min(result.stepUp.max_age, next.stepUp.max_age),
        };
      result.ruleIds.push(id);
    }
    return {
      ...result,
      approverRelation: action.approvers.relation,
      requesterRelation: action.requester_relation,
      ...(action.self_approval === "owner"
        ? { selfApproval: "owner" as const }
        : {}),
    };
  } catch {
    return base(p, "deny", "policy_evaluation_error");
  }
}
/** Caller assertions and operator ceilings apply to live, shadow and replay decisions. */
export function applyRequirementFloor(
  ctx: Ctx,
  p: PolicyDocument | null,
  action: string,
  args: Record<string, unknown>,
  assertion: string | undefined,
  decision: PolicyDecision,
): PolicyDecision {
  // The operator's approver relation is a floor the policy document cannot lower, for listed
  // actions, unknown-action handling and versions published before the floor was set.
  const floorRelation = ctx.tenant.actions[action]?.approverRelation;
  if (floorRelation && decision.approverRelation !== floorRelation)
    decision = { ...decision, approverRelation: floorRelation };
  if (decision.decision === "deny") return decision;
  const ceiling = Object.entries(
    ctx.tenant.actions[action]?.autoApproveCeilings ?? {},
  ).some(
    // A value that is present but not an integer cannot be shown to be under the ceiling.
    ([field, max]) =>
      args[field] !== undefined &&
      (!Number.isSafeInteger(args[field]) || (args[field] as number) > max),
  );
  if (assertion !== "human" && !ceiling) return decision;
  return {
    ...decision,
    decision: "approval_required",
    reasonCode:
      assertion === "human"
        ? "caller_raised_requirement"
        : "operator_approval_floor",
    tier: decision.tier ?? "routine",
    assurance: decision.assurance ?? p?.tiers.routine,
    quorum: decision.quorum ?? 1,
  };
}
export async function loadPolicy(
  db: Db,
  tenant: string,
  resourceServer: string,
  version?: string,
): Promise<PolicyDocument | null> {
  const r = version
    ? await db.query(
        "select document from authority.policy_versions where tenant_id=$1 and resource_server=$2 and version=$3",
        [tenant, resourceServer, version],
      )
    : await db.query(
        "select v.document from authority.policy_versions v join authority.policy_state s using(tenant_id,resource_server) where v.tenant_id=$1 and v.resource_server=$2 and v.version=s.active_version",
        [tenant, resourceServer],
      );
  return r.rows[0]?.document ?? null;
}
export async function listPolicies(db: Db, ctx: Ctx, resourceServer: string) {
  if (
    ctx.caller.kind !== "service" ||
    (!ctx.caller.permissions.has("policies:read") &&
      !ctx.caller.permissions.has("policies:write"))
  )
    throw new ServiceError(
      "not_authorized",
      "Policy read permission required.",
    );
  const r = await db.query(
    "select v.version,v.document,v.created_at,s.active_version=v.version as active,s.shadow_version=v.version as shadow from authority.policy_versions v left join authority.policy_state s using(tenant_id,resource_server) where v.tenant_id=$1 and v.resource_server=$2 order by v.created_at desc",
    [ctx.tenant.tenantId, resourceServer],
  );
  return {
    versions: r.rows.map((r) => ({
      version: r.version,
      document: r.document,
      createdAt: iso(r.created_at),
      active: r.active,
      shadow: r.shadow,
    })),
  };
}
export async function publishPolicy(
  db: Db,
  ctx: Ctx,
  document: unknown,
  options: { activate?: boolean; shadow?: boolean } = {},
) {
  requirePermission(ctx.caller, "policies:write");
  const p = validatePolicy(document);
  for (const [name, action] of Object.entries(p.actions)) {
    const floor = ctx.tenant.actions[name];
    if (floor && action.approvers.relation !== floor.approverRelation)
      invalid("Policy cannot change the operator approver floor.");
  }
  // Operator-configured actions the document omits fall to unknown-action handling.
  if (p.unknown_action === "approve")
    for (const [name, floor] of Object.entries(ctx.tenant.actions))
      if (
        !p.actions[name] &&
        p.unknown_action_approvers?.relation !== floor.approverRelation
      )
        invalid(
          `Policy cannot change the operator approver floor for ${name}: list the action or use its approver relation in unknown_action_approvers.`,
        );
  const existing = await loadPolicy(
    db,
    ctx.tenant.tenantId,
    p.resource_server,
    p.version,
  );
  if (existing)
    throw new ServiceError(
      "operation_conflict",
      "Policy version already exists; publish a new immutable version.",
    );
  const previous = await loadPolicy(db, ctx.tenant.tenantId, p.resource_server);
  const inserted = await db.query(
    "insert into authority.policy_versions(tenant_id,resource_server,version,document,created_by,created_at) values($1,$2,$3,$4,$5,$6) on conflict do nothing returning version",
    [
      ctx.tenant.tenantId,
      p.resource_server,
      p.version,
      JSON.stringify(p),
      actorOf(ctx).id,
      iso(ctx.now),
    ],
  );
  if (!inserted.rowCount)
    throw new ServiceError(
      "operation_conflict",
      "Policy version already exists; publish a new immutable version.",
    );
  await policyAudit(db, ctx, p, "policy.published", {
    document: p,
    diff: { before: previous, after: p },
  });
  if (options.activate || options.shadow)
    await activatePolicy(db, ctx, p.resource_server, p.version, {
      shadow: options.shadow,
    });
  return {
    warnings: Object.entries(p.actions)
      .filter(([, a]) => !a.rules.some((r) => /\bactor\.type\b/.test(r.when)))
      .map(
        ([name]) => `Action ${name} has no explicit agent/human distinction.`,
      ),
    version: p.version,
    document: p,
    active: !!options.activate && !options.shadow,
    shadow: !!options.shadow,
  };
}
async function policyAudit(
  db: Db,
  ctx: Ctx,
  p: PolicyDocument,
  type: string,
  extra: Record<string, unknown>,
) {
  await audit(db, {
    type: type as any,
    tenantId: ctx.tenant.tenantId,
    organizationId: ctx.caller.subject?.orgId ?? "tenant",
    correlationId: ctx.correlationId,
    actor: actorOf(ctx),
    decision: "info",
    at: ctx.now,
    evaluation: {
      resourceServer: p.resource_server,
      policyVersion: p.version,
      ...extra,
    },
  });
}
export async function activatePolicy(
  db: Db,
  ctx: Ctx,
  resourceServer: string,
  version: string,
  options: { shadow?: boolean } = {},
) {
  requirePermission(ctx.caller, "policies:write");
  const p = await loadPolicy(db, ctx.tenant.tenantId, resourceServer, version);
  if (!p) throw new ServiceError("not_found", "Policy version not found.");
  const field = options.shadow ? "shadow_version" : "active_version";
  const previous = await db.query(
    "select active_version,shadow_version from authority.policy_state where tenant_id=$1 and resource_server=$2",
    [ctx.tenant.tenantId, resourceServer],
  );
  await db.query(
    `insert into authority.policy_state(tenant_id,resource_server,${field}) values($1,$2,$3) on conflict(tenant_id,resource_server) do update set ${field}=$3`,
    [ctx.tenant.tenantId, resourceServer, version],
  );
  await policyAudit(
    db,
    ctx,
    p,
    options.shadow ? "policy.shadowed" : "policy.activated",
    { previousVersion: previous.rows[0]?.[field] ?? null },
  );
  return { version, active: !options.shadow, shadow: !!options.shadow };
}
export async function simulatePolicy(
  db: Db,
  ctx: Ctx,
  resourceServer: string,
  version: string,
  since: string | number,
) {
  requirePermission(ctx.caller, "policies:write");
  const p = await loadPolicy(db, ctx.tenant.tenantId, resourceServer, version);
  if (!p) throw new ServiceError("not_found", "Policy version not found.");
  const sinceMs =
    typeof since === "number"
      ? since
      : /^\d+[smhd]$/.test(since)
        ? ctx.now - milliseconds(since)
        : Date.parse(since);
  if (!Number.isFinite(sinceMs)) invalid("Invalid simulation since date.");
  const rows = await db.query<OperationRow>(
    "select * from authority.operations where tenant_id=$1 and resource_server=$2 and created_at >= $3 order by created_at,id limit 10001",
    [ctx.tenant.tenantId, resourceServer, iso(sinceMs)],
  );
  const claims = await db.query<{
    operation_id: string;
    status: string;
    minted_at: Date;
    outcome: Record<string, unknown> | null;
  }>(
    "select operation_id,status,minted_at,outcome from authority.claims where tenant_id=$1 and operation_id=any($2::text[]) order by minted_at",
    [ctx.tenant.tenantId, rows.rows.slice(0, 10000).map((o) => o.id)],
  );
  const outcomes: Record<string, number> = {},
    rules: Record<string, number> = {},
    tiers: Record<string, number> = {};
  const changed: unknown[] = [];
  const ledger: {
    key: string;
    amount: number;
    registered: number;
    capture: number | null;
    released: number | null;
    expires: number;
  }[] = [];
  let budgetOverruns = 0;
  for (const o of rows.rows.slice(0, 10000)) {
    const now = o.created_at.getTime(),
      inputs = {
        action: o.action,
        resource: o.resource,
        args: o.arguments,
        facts: o.facts ?? {},
        actor: o.actor,
        relations: o.policy_details.relationInputs ?? {},
        aggregates: {},
      };
    let decision = applyRequirementFloor(
      ctx,
      p,
      o.action,
      o.arguments,
      o.approval_assertion,
      evaluatePolicy(p, o.action, inputs),
    );
    if (decision.budgetRuleIds.length) {
      const bindings = budgetBindings(
        p,
        o.action,
        decision.budgetRuleIds,
        {
          delegationId: o.delegation_id,
          principal: o.initiator_id ?? o.actor.id,
          organizationId: o.organization_id,
        },
        o.arguments,
      );
      const exhausted = new Set<string>();
      for (const b of bindings) {
        const key = `${b.ruleId}:${b.scopeKey}`;
        const used = ledger.filter(
          (v) =>
            v.key === key &&
            (v.released === null || v.released > now) &&
            (v.capture !== null && v.capture <= now
              ? v.capture > now - b.windowMs
              : v.expires > now),
        );
        const amount = used.reduce((n, v) => n + v.amount, 0);
        if (
          b.scopeKey === "missing-delegation" ||
          (b.budget.max_count !== undefined &&
            used.length + 1 > b.budget.max_count) ||
          (b.budget.max_amount_minor !== undefined &&
            amount + b.amount > b.budget.max_amount_minor)
        )
          exhausted.add(b.ruleId);
      }
      if (exhausted.size) {
        budgetOverruns++;
        decision = applyRequirementFloor(
          ctx,
          p,
          o.action,
          o.arguments,
          o.approval_assertion,
          evaluatePolicy(p, o.action, inputs, exhausted),
        );
      }
      if (decision.decision === "allow")
        for (const b of bindings.filter((b) => !exhausted.has(b.ruleId))) {
          const actual = claims.rows.find(
            (c) => c.operation_id === o.id && c.status !== "released",
          );
          const releasedClaim = claims.rows.find(
            (c) => c.operation_id === o.id && c.status === "released",
          );
          const releasedAt = releasedClaim?.outcome?.reportedAt;
          ledger.push({
            key: `${b.ruleId}:${b.scopeKey}`,
            amount: b.amount,
            registered: now,
            capture: actual?.minted_at.getTime() ?? null,
            released:
              typeof releasedAt === "string"
                ? Date.parse(releasedAt)
                : o.status === "cancelled" || o.status === "rejected"
                  ? now
                  : null,
            expires: Math.min(
              now + milliseconds(p.budget_hold_ttl ?? "15m"),
              o.expires_at.getTime(),
            ),
          });
        }
    }
    outcomes[decision.decision] = (outcomes[decision.decision] ?? 0) + 1;
    for (const r of decision.ruleIds) rules[r] = (rules[r] ?? 0) + 1;
    if (decision.tier) tiers[decision.tier] = (tiers[decision.tier] ?? 0) + 1;
    if (decision.decision !== o.decision)
      changed.push({ operationId: o.id, previous: o.decision, decision });
  }
  return {
    version,
    since: iso(sinceMs),
    counts: { outcomes, rules, tiers, budgetOverruns },
    changed,
    truncated: rows.rows.length > 10000,
    budgetEvaluation:
      "Chronological reservation replay using recorded claim and release outcomes; facts and actor are the original verified snapshots.",
  };
}
export function policyActor(ctx: Ctx, delegated: boolean): PolicyActor {
  const s = ctx.caller.subject;
  const c = ctx.caller;
  const verified =
    s?.actorType ?? (c.kind === "service" ? c.actorType : undefined);
  return {
    type: delegated
      ? "agent"
      : (verified ?? (c.kind === "user" || s ? "human" : "agent")),
    id: s?.sub ?? (c.kind === "service" ? c.clientId : "unknown"),
    ...(s?.act
      ? { act: s.act }
      : c.kind === "service" && c.act
        ? { act: c.act }
        : {}),
  };
}
type BudgetBinding = {
  ruleId: string;
  scopeKey: string;
  windowMs: number;
  amount: number;
  budget: z.infer<typeof budgetSchema>;
};
function budgetBindings(
  p: PolicyDocument,
  action: string,
  ids: string[],
  identity: {
    delegationId: string | null;
    principal: string;
    organizationId: string;
  },
  args: Record<string, unknown>,
): BudgetBinding[] {
  const a = p.actions[action];
  if (!a) return [];
  return ids.flatMap((id) => {
    const value =
      id === "default" ? a.default : a.rules.find((r) => r.id === id)?.then;
    if (!value || !("allow" in value) || !value.allow.budget) return [];
    const budget = value.allow.budget;
    const key =
      budget.per === "delegation"
        ? identity.delegationId
        : budget.per === "principal"
          ? identity.principal
          : identity.organizationId;
    if (!key)
      return [
        {
          ruleId: id,
          scopeKey: "missing-delegation",
          windowMs: milliseconds(budget.window),
          amount: Number.MAX_SAFE_INTEGER,
          budget,
        },
      ];
    const amountArg = budgetAmountArgument(budget, a.arguments);
    const amount =
      budget.max_amount_minor === undefined
        ? 0
        : amountArg
          ? args[amountArg]
          : undefined;
    if (
      typeof amount !== "number" ||
      !Number.isSafeInteger(amount) ||
      amount < 0
    )
      throw new ServiceError(
        "invalid_request",
        "Budget amount must be a nonnegative integer minor unit.",
      );
    return [
      {
        ruleId: id,
        scopeKey: `${budget.per}:${key}`,
        windowMs: milliseconds(budget.window),
        amount,
        budget,
      },
    ];
  });
}
export async function budgetAvailability(
  db: Db,
  ctx: Ctx,
  p: PolicyDocument,
  action: string,
  ids: string[],
  identity: {
    delegationId: string | null;
    principal: string;
    organizationId: string;
  },
  args: Record<string, unknown>,
  lock = false,
  excludeOperationId: string | null = null,
) {
  const bindings = budgetBindings(p, action, ids, identity, args).sort((a, b) =>
    `${a.ruleId}:${a.scopeKey}`.localeCompare(`${b.ruleId}:${b.scopeKey}`),
  );
  const exhausted = new Set<string>();
  for (const b of bindings) {
    if (lock)
      await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${ctx.tenant.tenantId}:${p.resource_server}:${b.ruleId}:${b.scopeKey}`,
      ]);
    const r = await db.query(
      "select count(*)::int as count,coalesce(sum(b.amount_minor),0)::text as amount from authority.policy_budget_consumption b where b.tenant_id=$1 and b.resource_server=$2 and b.rule_id=$3 and b.scope_key=$4 and ((b.status='captured' and (b.consumed_at>$5 or exists(select 1 from authority.claims c where c.id=b.claim_id and c.status in ('claimed','pending','unknown')))) or (b.status='held' and b.hold_expires_at>$6)) and ($7::text is null or b.operation_id<>$7)",
      [
        ctx.tenant.tenantId,
        p.resource_server,
        b.ruleId,
        b.scopeKey,
        iso(ctx.now - b.windowMs),
        iso(ctx.now),
        excludeOperationId,
      ],
    );
    const used = r.rows[0];
    if (
      b.scopeKey === "missing-delegation" ||
      (b.budget.max_count !== undefined &&
        Number(used.count) + 1 > b.budget.max_count) ||
      (b.budget.max_amount_minor !== undefined &&
        Number(used.amount) + b.amount > b.budget.max_amount_minor)
    )
      exhausted.add(b.ruleId);
  }
  return { exhausted, bindings };
}
export async function reserveBudgets(
  db: Db,
  ctx: Ctx,
  p: PolicyDocument,
  operationId: string,
  bindings: BudgetBinding[],
) {
  for (const b of bindings)
    await db.query(
      "insert into authority.policy_budget_consumption(tenant_id,resource_server,policy_version,rule_id,scope_key,operation_id,amount_minor,consumed_at,hold_expires_at,status) values($1,$2,$3,$4,$5,$6,$7,$8,least($9::timestamptz,(select expires_at from authority.operations where id=$6)),'held') on conflict(operation_id,rule_id) do update set status='held',consumed_at=$8,hold_expires_at=excluded.hold_expires_at,claim_id=null",
      [
        ctx.tenant.tenantId,
        p.resource_server,
        p.version,
        b.ruleId,
        b.scopeKey,
        operationId,
        b.amount,
        iso(ctx.now),
        iso(ctx.now + milliseconds(p.budget_hold_ttl ?? "15m")),
      ],
    );
}
export async function consumeBudgets(
  db: Db,
  ctx: Ctx,
  p: PolicyDocument,
  o: OperationRow,
  claimId: string,
  bindings: BudgetBinding[],
) {
  await reserveBudgets(db, ctx, p, o.id, bindings);
  await db.query(
    "update authority.policy_budget_consumption set status='captured',claim_id=$2,consumed_at=$3 where operation_id=$1 and status='held'",
    [o.id, claimId, iso(ctx.now)],
  );
}
export async function releaseBudgetReservations(
  db: Db,
  ctx: Ctx,
  operationId: string,
) {
  await db.query(
    "update authority.policy_budget_consumption set status='released' where operation_id=$1 and tenant_id=$2 and status in ('held','captured')",
    [operationId, ctx.tenant.tenantId],
  );
}
export async function shadowEvaluation(
  db: Db,
  ctx: Ctx,
  resourceServer: string,
  action: string,
  inputs: Record<string, unknown>,
  baseAudit: Record<string, any>,
) {
  const s = await db.query(
    "select shadow_version from authority.policy_state where tenant_id=$1 and resource_server=$2",
    [ctx.tenant.tenantId, resourceServer],
  );
  if (!s.rows[0]?.shadow_version) return;
  const p = await loadPolicy(
    db,
    ctx.tenant.tenantId,
    resourceServer,
    s.rows[0].shadow_version,
  );
  let result = evaluatePolicy(p, action, inputs);
  if (p && result.budgetRuleIds.length) {
    const available = await budgetAvailability(
      db,
      ctx,
      p,
      action,
      result.budgetRuleIds,
      {
        delegationId: baseAudit.delegationId ?? null,
        principal: (inputs.actor as PolicyActor).id,
        organizationId: baseAudit.organizationId,
      },
      inputs.args as Record<string, unknown>,
      false,
      baseAudit.operationId ?? null,
    );
    result = evaluatePolicy(p, action, inputs, available.exhausted);
  }
  result = applyRequirementFloor(
    ctx,
    p,
    action,
    inputs.args as Record<string, unknown>,
    typeof inputs.approvalAssertion === "string"
      ? inputs.approvalAssertion
      : undefined,
    result,
  );
  await audit(db, {
    ...baseAudit,
    type: "policy.shadow_evaluated" as any,
    decision: "info",
    evaluation: { ...result, facts: inputs.facts, actor: inputs.actor },
  } as any);
}
export const POLICY_TEMPLATES: Record<string, PolicyDocument> = {
  refunds: {
    resource_server: "https://api.northstar.example",
    version: "refunds.v1",
    unknown_action: "deny",
    actions: {
      "refund:create": {
        arguments: { amountMinor: "int", currency: "string" },
        approvers: { relation: "refund_approve", on: "organization" },
        rules: [
          {
            id: "small",
            when: 'actor.type == "agent" && args.amountMinor <= 10000',
            then: {
              allow: {
                budget: {
                  per: "principal",
                  window: "24h",
                  max_amount_minor: 50000,
                  max_count: 20,
                },
              },
            },
          },
          {
            id: "high-value",
            when: "args.amountMinor > 100000",
            then: { approve: { tier: "high_value", quorum: 2 } },
          },
        ],
        default: { approve: { tier: "routine" } },
      },
    },
    tiers: {
      routine: { assurance: "session_mfa", max_age: 3600, dpop: "required" },
      high_value: {
        assurance: "per_operation",
        factors: ["webauthn-platform", "webauthn-roaming"],
        batch_max: 5,
      },
    },
  },
  "production-deploys": {
    resource_server: "https://deploy.example",
    version: "deploys.v1",
    unknown_action: "deny",
    actions: {
      "deploy:production": {
        arguments: { environment: "string" },
        approvers: { relation: "deploy_approve", on: "organization" },
        rules: [
          {
            id: "agent-production-deploy",
            when: 'actor.type == "agent"',
            then: { approve: { tier: "high_value", quorum: 2 } },
          },
        ],
        default: { approve: { tier: "high_value", quorum: 2 } },
      },
    },
    tiers: {
      high_value: {
        assurance: "per_operation",
        factors: ["webauthn-platform", "webauthn-roaming"],
        batch_max: 1,
      },
    },
  },
  "data-exports": {
    resource_server: "https://data.example",
    version: "exports.v1",
    unknown_action: "deny",
    actions: {
      "data:export": {
        arguments: { rowCount: "int" },
        approvers: { relation: "export_approve", on: "organization" },
        rules: [
          {
            id: "agent-export-review",
            when: 'actor.type == "agent"',
            then: { approve: { tier: "routine" } },
          },
          {
            id: "large-export",
            when: "args.rowCount > 1000",
            then: { approve: { tier: "high_value" } },
          },
        ],
        default: { approve: { tier: "routine" } },
      },
    },
    tiers: {
      routine: { assurance: "session_mfa", max_age: 900, dpop: "required" },
      high_value: {
        assurance: "per_operation",
        factors: ["webauthn-platform", "webauthn-roaming"],
        batch_max: 1,
      },
    },
  },
};

export function callerAssuranceSatisfied(
  ctx: Ctx,
  needed: { acr: string; max_age: number },
): boolean {
  const s = ctx.caller.subject;
  if (
    !s ||
    s.authTime === null ||
    s.authTime > ctx.now / 1000 + ctx.config.clockSkewSec ||
    ctx.now / 1000 - s.authTime > needed.max_age
  )
    return false;
  const acr = (s as typeof s & { acr?: string | null }).acr?.split(" ") ?? [];
  return needed.acr
    .split(" ")
    .every(
      (a) =>
        acr.includes(a) ||
        ([
          "mfa",
          "http://schemas.openid.net/pape/policies/2007/06/multi-factor",
          "urn:task-authority:mfa",
        ].includes(a) &&
          s.amr.includes("mfa")),
    );
}

/** Reviewer idle window for a session tier: a policy duration, or legacy seconds, default 15 minutes. */
export function idleTimeoutMs(tier: Record<string, unknown>): number {
  const v = tier.idle_timeout;
  return typeof v === "string"
    ? milliseconds(v)
    : typeof v === "number"
      ? v * 1000
      : 900_000;
}
