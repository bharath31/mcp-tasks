// The short path: configuration lives in task-authority.json and TASK_AUTHORITY_*
// environment variables, and each protected mutation is declared once with
// `authority.action(...)`. Everything here is sugar over TaskAuthority and protect;
// both stay public for code that needs the full contract.
import type { Json } from "@task-authority/contracts";
import { TaskAuthority, type RetryPolicy } from "./client.js";
import {
  protect,
  renderCli,
  renderMcp,
  renderRest,
  type ProtectOptions,
  type ProtectedOutcome,
  type RenderMcpOptions,
} from "./protect.js";
import {
  verifiedSubject,
  type ClaimAuthorized,
  type ClaimReconcile,
  type OperationView,
  type RegisterInput,
  type VerifiedSubject,
} from "./types.js";

type ClientCredentials = { clientId: string; clientSecret: string };

/** Every field can come from code, the environment or task-authority.json (in that order). */
export type TaskAuthorityConfig = {
  /** Task Authority base URL. Env: TASK_AUTHORITY_URL. */
  url?: string;
  /** Policy namespace shared by every transport onto this API. Env: TASK_AUTHORITY_RESOURCE_SERVER. */
  resourceServer?: string;
  /** Default organization for callers. Env: TASK_AUTHORITY_ORGANIZATION. */
  organizationId?: string;
  /** Reviewer link, with {approvalId} replaced. Env: TASK_AUTHORITY_REVIEW_URL. */
  reviewUrl?: string;
  /** Auth0 tenant domain for client credentials. Env: AUTH0_DOMAIN. */
  domain?: string;
  /** Task Authority API audience. Env: TASK_AUTHORITY_AUDIENCE. */
  audience?: string;
  /** Registers operations. Env: TASK_AUTHORITY_CLIENT_ID, TASK_AUTHORITY_CLIENT_SECRET. */
  api?: ClientCredentials;
  /** Claims right before the side effect; defaults to `api`. Env: TASK_AUTHORITY_EXECUTOR_CLIENT_ID, TASK_AUTHORITY_EXECUTOR_CLIENT_SECRET. */
  executor?: ClientCredentials;
  /** Code-only overrides for token sources (e.g. a secret manager). */
  getAccessToken?: () => Promise<string>;
  getExecutorAccessToken?: () => Promise<string>;
  /** Path of the JSON config file. Env: TASK_AUTHORITY_CONFIG. Default ./task-authority.json if present. */
  configFile?: string;
  /** Environment to read instead of process.env (e.g. a Cloudflare Worker's env). */
  env?: Record<string, unknown>;
  fetch?: typeof fetch;
  retry?: Partial<RetryPolicy>;
};

export type ActionContext = {
  /** The authorized claim. Reported automatically unless you call claim.report yourself. */
  claim: ClaimAuthorized | ClaimReconcile;
  operation: OperationView;
  /** Stable key of this logical side effect: pass it as the provider's idempotency key. */
  key: string;
};

export type ActionDefinition<I extends Record<string, Json>, R> = {
  /** The exact resource this operation touches, e.g. `payment:${input.paymentId}`. */
  resource: (input: I) => string;
  /** The side effect. Runs only after an authorized claim. */
  run: (input: I, ctx: ActionContext) => Promise<R>;
  /** Business facts the policy reads (recorded assertions, derive them from trusted data). */
  facts?: (input: I) => Promise<Record<string, Json>> | Record<string, Json>;
  /** Business-state version bound into the operation digest. */
  version?: (input: I) => Promise<string> | string;
  /** Read-only provider lookup after an uncertain claim. Return null if nothing was submitted. */
  reconcile?: (input: I, ctx: ActionContext) => Promise<R | null>;
  /** Provider reference for the outcome report. Default: `result.id` when it is a string. */
  reference?: (result: R) => string | undefined;
};

export type CallOptions = {
  /** The caller's verified access token for the Task Authority audience (or a VerifiedSubject). */
  user?: string | VerifiedSubject;
  /** Delegation id when an agent acts for its owner. */
  delegation?: string;
  org?: string;
  /** Stable idempotency key for this logical side effect. Default: a fresh id per call. */
  key?: string;
  facts?: Record<string, Json>;
  version?: string;
  taskId?: string;
  approvalAssertion?: RegisterInput["approvalAssertion"];
  /** Register without claiming or waking a reviewer (business prerequisites still pending). */
  prepareOnly?: boolean;
};

export type ActionOutcome<R> = ProtectedOutcome<R> & {
  /** Web Response: 201 done, 202 awaiting approval, 401 step-up, 403 denied. */
  toResponse(): Response;
  toMcp(options?: RenderMcpOptions): ReturnType<typeof renderMcp>;
  toCli(): ReturnType<typeof renderCli>;
};

export type ProtectedAction<I extends Record<string, Json>, R> = ((
  input: I,
  options?: CallOptions,
) => Promise<ActionOutcome<R>>) & {
  readonly action: string;
  /**
   * Continue a registered operation, e.g. after its approval. Pass the input from your
   * own durable record of the request: it is what `run` executes. Its action and
   * resource must match the operation.
   */
  resume(
    operationId: string,
    input: I,
    options?: { version?: string },
  ): Promise<ActionOutcome<R>>;
};

export type TaskAuthorityApp = TaskAuthority & {
  readonly executor: TaskAuthority;
  action<I extends Record<string, Json>, R>(
    name: string,
    definition: ActionDefinition<I, R>,
  ): ProtectedAction<I, R>;
};

/**
 * One client, configured from code, TASK_AUTHORITY_* environment variables and
 * task-authority.json. Secrets belong in the environment, not the file.
 */
export function createTaskAuthority(
  config: TaskAuthorityConfig = {},
): TaskAuthorityApp {
  const c = resolveConfig(config);
  const client = (getAccessToken: () => Promise<string>) =>
    new TaskAuthority({
      baseUrl: c.url,
      getAccessToken,
      fetch: c.fetch,
      retry: c.retry,
    });
  const authority = client(
    c.getAccessToken ?? clientCredentials(c, c.api, "TASK_AUTHORITY_CLIENT_ID"),
  );
  const executor =
    c.getExecutorAccessToken || c.executor
      ? client(
          c.getExecutorAccessToken ??
            clientCredentials(
              c,
              c.executor,
              "TASK_AUTHORITY_EXECUTOR_CLIENT_ID",
            ),
        )
      : authority;
  return Object.assign(authority, {
    executor,
    action: <I extends Record<string, Json>, R>(
      name: string,
      def: ActionDefinition<I, R>,
    ) => defineAction(authority, executor, c, name, def),
  });
}

function defineAction<I extends Record<string, Json>, R>(
  authority: TaskAuthority,
  executor: TaskAuthority,
  c: ResolvedConfig,
  action: string,
  def: ActionDefinition<I, R>,
): ProtectedAction<I, R> {
  const reviewUrl = c.reviewUrl
    ? (id: string) =>
        c.reviewUrl!.replaceAll("{approvalId}", encodeURIComponent(id))
    : undefined;
  const guard = async (
    input: I,
    facts: () => Promise<Omit<RegisterInput, "action">>,
    options: ProtectOptions<R>,
  ) => {
    const step =
      (fn: NonNullable<ActionDefinition<I, R>["reconcile"]>) =>
      (claim: ClaimAuthorized | ClaimReconcile, operation: OperationView) =>
        reported(claim, def, (ctx) => fn(input, ctx), operation);
    return withRenderers(
      await protect(authority, action, facts, step(def.run), {
        executor,
        reviewUrl,
        reconcile: def.reconcile ? step(def.reconcile) : undefined,
        ...options,
      }),
    );
  };

  const call = async (input: I, o: CallOptions = {}) => {
    const organizationId =
      o.org ??
      (typeof o.user === "object" ? o.user.organizationId : undefined) ??
      c.organizationId;
    if (o.user && !organizationId)
      throw new Error(
        "task_authority_config: organizationId is missing. Set TASK_AUTHORITY_ORGANIZATION or pass { org }.",
      );
    const initiator =
      typeof o.user === "string"
        ? verifiedSubject({
            accessToken: o.user,
            organizationId: organizationId!,
          })
        : o.user;
    const key = o.key ?? `${action}:${crypto.randomUUID()}`;
    const version = o.version ?? (await def.version?.(input));
    return guard(
      input,
      async () => ({
        operationKey: key,
        resource: def.resource(input),
        arguments: input,
        resourceServer: c.resourceServer,
        organizationId,
        delegationId: o.delegation,
        initiator,
        taskId: o.taskId,
        approvalAssertion: o.approvalAssertion,
        businessStateVersion: version,
        facts: o.facts ?? (await def.facts?.(input)),
      }),
      {
        executionKey: key,
        businessStateVersion: version,
        prepareOnly: o.prepareOnly,
      },
    );
  };
  const resume = async (
    operationId: string,
    input: I,
    o: { version?: string } = {},
  ) => {
    const operation = await authority.operations.get(operationId);
    // `run` executes `input`, so it must be exactly what was registered: the digest, and any
    // approval of it, covers the registered arguments, never what the caller passes now.
    if (
      operation.action !== action ||
      operation.resource !== def.resource(input) ||
      !operation.arguments ||
      canonicalJson(operation.arguments) !== canonicalJson(input)
    )
      throw new Error("resume_input_mismatch");
    return guard(
      input,
      async () => {
        throw new Error("registered_operation_required");
      },
      {
        operation,
        businessStateVersion: o.version ?? (await def.version?.(input)),
      },
    );
  };
  return Object.assign(call, { action, resume });
}

/** Sorted-key JSON, so key order never decides whether two argument sets match. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Runs the side effect and reports its outcome unless the callback already did. */
async function reported<I extends Record<string, Json>, R>(
  claim: ClaimAuthorized | ClaimReconcile,
  def: ActionDefinition<I, R>,
  fn: (ctx: ActionContext) => Promise<R | null>,
  operation: OperationView,
): Promise<R> {
  let reportedByCaller = false;
  const report = claim.report.bind(claim);
  const tracked = Object.defineProperty({ ...claim }, "report", {
    enumerable: false,
    value: (...args: Parameters<typeof report>) => {
      reportedByCaller = true;
      return report(...args);
    },
  }) as typeof claim;
  let result: R | null;
  try {
    result = await fn({
      claim: tracked,
      operation,
      key: operation.operationKey,
    });
  } catch (e) {
    // An exception does not prove the provider did nothing: reconcile before another attempt.
    if (!reportedByCaller) await report("unknown").catch(() => undefined);
    throw e;
  }
  if (!reportedByCaller) {
    if (result === null) await report("not_submitted");
    else await report("succeeded", referenceOf(def, result));
  }
  return result as R;
}

const referenceOf = <R>(
  def: { reference?: (r: R) => string | undefined },
  r: R,
) => {
  if (def.reference) return def.reference(r);
  const id = (r as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? id : undefined;
};

function withRenderers<R>(outcome: ProtectedOutcome<R>): ActionOutcome<R> {
  // Non-enumerable, so the outcome still serializes exactly like protect()'s.
  return Object.defineProperties(outcome, {
    toResponse: { value: () => renderRest(outcome) },
    toMcp: { value: (o?: RenderMcpOptions) => renderMcp(outcome, o) },
    toCli: { value: () => renderCli(outcome) },
  }) as ActionOutcome<R>;
}

type ResolvedConfig = TaskAuthorityConfig & { url: string };

const ENV: Record<string, keyof TaskAuthorityConfig> = {
  TASK_AUTHORITY_URL: "url",
  TASK_AUTHORITY_RESOURCE_SERVER: "resourceServer",
  TASK_AUTHORITY_ORGANIZATION: "organizationId",
  TASK_AUTHORITY_REVIEW_URL: "reviewUrl",
  AUTH0_DOMAIN: "domain",
  TASK_AUTHORITY_AUDIENCE: "audience",
};

/** Code wins over the environment, which wins over the config file. */
export function resolveConfig(
  config: TaskAuthorityConfig = {},
): ResolvedConfig {
  const env = (config.env ??
    (globalThis as { process?: { env?: Record<string, unknown> } }).process
      ?.env ??
    {}) as Record<string, unknown>;
  const str = (k: string) =>
    typeof env[k] === "string" && env[k] ? (env[k] as string) : undefined;
  const fromEnv: TaskAuthorityConfig = {};
  for (const [k, field] of Object.entries(ENV))
    if (str(k)) (fromEnv as Record<string, unknown>)[field] = str(k);
  const creds = (prefix: string) =>
    str(`${prefix}_ID`) && str(`${prefix}_SECRET`)
      ? {
          clientId: str(`${prefix}_ID`)!,
          clientSecret: str(`${prefix}_SECRET`)!,
        }
      : undefined;
  fromEnv.api = creds("TASK_AUTHORITY_CLIENT");
  fromEnv.executor = creds("TASK_AUTHORITY_EXECUTOR_CLIENT");
  // An explicitly passed env (a Worker) means no file unless one is named.
  const path = config.configFile ?? str("TASK_AUTHORITY_CONFIG");
  const file = path || !config.env ? readConfigFile(path) : {};
  const merged = { ...file, ...defined(fromEnv), ...defined(config) };
  if (!merged.url)
    throw new Error(
      "task_authority_config: url is missing. Set TASK_AUTHORITY_URL or add url to task-authority.json.",
    );
  return merged as ResolvedConfig;
}

const defined = <T extends object>(o: T) =>
  Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as Partial<T>;

function readConfigFile(path?: string): TaskAuthorityConfig {
  // Synchronous and optional: Node has node:fs, a Worker passes config or env instead.
  const fs = (
    globalThis as {
      process?: { getBuiltinModule?: (id: string) => unknown };
    }
  ).process?.getBuiltinModule?.("node:fs") as
    | {
        readFileSync(p: string, e: "utf8"): string;
        existsSync(p: string): boolean;
      }
    | undefined;
  const target = path ?? "task-authority.json";
  if (!fs || (!path && !fs.existsSync(target))) return {};
  return JSON.parse(fs.readFileSync(target, "utf8")) as TaskAuthorityConfig;
}

/** Cached Auth0 client-credentials token for the Task Authority audience. */
function clientCredentials(
  c: ResolvedConfig,
  creds: ClientCredentials | undefined,
  envName: string,
) {
  let cache: { token: string; exp: number } | null = null;
  return async () => {
    if (cache && cache.exp > Date.now() + 30_000) return cache.token;
    if (!creds || !c.domain || !c.audience)
      throw new Error(
        `task_authority_config: credentials are missing. Set AUTH0_DOMAIN, TASK_AUTHORITY_AUDIENCE, ${envName} and its _SECRET, or pass getAccessToken.`,
      );
    const res = await (c.fetch ?? fetch)(
      `https://${c.domain.replace(/^https?:\/\//, "").replace(/\/$/, "")}/oauth/token`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          audience: c.audience,
        }),
      },
    );
    if (!res.ok) throw new Error(`task_authority_token_failed: ${res.status}`);
    const j = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    cache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return cache.token;
  };
}
