// Worker bindings and configuration. Minimal local types so this folder
// type-checks under the repo root tsconfig without Cloudflare globals.
export type Fetcher = { fetch(request: Request): Promise<Response> };
/** Workers AI binding (`"ai": { "binding": "AI" }` in wrangler.jsonc). */
export type AiBinding = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
};
export type Env = {
  /** Cloudflare Hyperdrive binding in front of Postgres (preferred). */
  HYPERDRIVE?: { connectionString: string };
  /** Direct Postgres URL fallback (local development and tests). */
  DATABASE_URL?: string;
  /**
   * "false" when the Worker connects as the least-privilege runtime role, which cannot
   * run DDL: migrations are then applied out of band by tools/migrate.ts as the owner.
   */
  MIGRATE_ON_REQUEST?: string;
  /** Static assets binding (the built UI in web/dist). */
  ASSETS?: Fetcher;
  PUBLIC_URL?: string;

  // Real Auth0 tenant (identity, MFA, DPoP and step-up are never simulated).
  AUTH0_DOMAIN?: string;
  AUTH0_CLIENT_ID?: string;
  AUTH0_CLIENT_SECRET?: string;
  /** Optional local-only fetch override for tests using a TLS OIDC fixture. */
  APPROVAL_FETCH?: typeof fetch;
  APP_URL?: string;
  /** Auth0 Regular Web App used only for approve() link proofs. */
  APPROVAL_CLIENT_ID?: string;
  APPROVAL_CLIENT_SECRET?: string;
  AUTH0_APPROVAL_CONNECTION?: string;
  AUTH0_APPROVAL_LOGIN_METHOD?: "passkey" | "email-otp";
  APPROVAL_MODE?: "authority" | "approve";
  APPROVAL_ROLE?: string;
  /** Audience of the Task Authority API (the SPA requests this). */
  TASK_AUTHORITY_AUDIENCE?: string;
  /** Audience the agent client requests for the refund app; defaults to the Task Authority audience. */
  APP_AUDIENCE?: string;
  AUTH0_CLAIM_NAMESPACE?: string;
  /** Public values handed to the SPA via /sandbox/info. */
  SPA_CLIENT_ID?: string;
  AUTH0_ORG_ID?: string;

  // Backend M2M clients (secrets). Each role maps to a client with only its permissions.
  AUTHORITY_API_CLIENT_ID?: string;
  AUTHORITY_API_CLIENT_SECRET?: string;
  AUTHORITY_EXECUTOR_CLIENT_ID?: string;
  AUTHORITY_EXECUTOR_CLIENT_SECRET?: string;
  AUTHORITY_AUDITOR_CLIENT_ID?: string;
  AUTHORITY_AUDITOR_CLIENT_SECRET?: string;
  AUTHORITY_ADMIN_CLIENT_ID?: string;
  AUTHORITY_ADMIN_CLIENT_SECRET?: string;
  /** The real Auth0 user ("Alex") who delegates to the agent; refresh-token grant. */
  AGENT_OWNER_CLIENT_ID?: string;
  AGENT_OWNER_CLIENT_SECRET?: string;
  AGENT_OWNER_REFRESH_TOKEN?: string;
  /** The AI agent's Auth0 M2M client: used by the LLM agent's MCP client and the scenario endpoint. */
  AGENT_CLIENT_ID?: string;
  AGENT_CLIENT_SECRET?: string;
  /**
   * Auth0 M2M client whose tokens the console hands to a visitor's own agent (Claude Code or
   * any MCP client) as a sandbox agent key. Its tokens are accepted only while bound to one
   * sandbox in policy_desk.agent_keys; unset means "Connect your agent" is unavailable.
   */
  EXTERNAL_AGENT_CLIENT_ID?: string;
  EXTERNAL_AGENT_CLIENT_SECRET?: string;
  /** PKCS#8 PEM for private_key_jwt; used instead of the client secret when set. */
  EXTERNAL_AGENT_PRIVATE_KEY?: string;
  /** kid of the matching public key registered on the Auth0 client (optional). */
  EXTERNAL_AGENT_KEY_ID?: string;
  /** Registered agent id in FGA and delegations. */
  AGENT_ID?: string;
  /** Workers AI: the model behind the refund agent. */
  AI?: AiBinding;
  /** Workers AI model id for the agent; defaults to DEFAULT_AGENT_MODEL in agent.ts. */
  AGENT_MODEL?: string;

  // Real Auth0 FGA store.
  FGA_API_URL?: string;
  FGA_STORE_ID?: string;
  FGA_MODEL_ID?: string;
  /** Static bearer for Check (preshared key or pre-fetched token). */
  FGA_API_TOKEN?: string;
  /** Static bearer with write access, used only to seed the visitor's sandbox tuples. */
  FGA_ADMIN_TOKEN?: string;
  /** Alternative to static tokens: Auth0 FGA client credentials. */
  FGA_CLIENT_ID?: string;
  FGA_CLIENT_SECRET?: string;
  FGA_TOKEN_URL?: string;
  FGA_TOKEN_AUDIENCE?: string;
  /** Local tests only: use the in-Postgres tuple table instead of FGA. Refused unless "1". */
  ALLOW_LOCAL_FGA?: string;

  /** Operators allowed on /admin: verified sign-in emails and/or Auth0 subjects (comma separated). */
  ADMIN_EMAILS?: string;
  /** Audience of tokens MCP hosts get when they sign in themselves; defaults to <origin>/mcp. */
  MCP_RESOURCE?: string;
  /** Pre-registered Auth0 client id for MCP hosts (e.g. `claude mcp add --client-id`). */
  MCP_CLIENT_ID?: string;
  /** Universal Login connection the console requests; defaults to "email" (passwordless OTP). */
  LOGIN_CONNECTION?: string;
  /** Workers rate limiting binding: per-IP cap on /sandbox/* and /v1/* before any DB work. */
  EDGE_LIMIT?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  ADMIN_SUBS?: string;

  HIGH_VALUE_QUORUM?: string;
  IP_HASH_SALT?: string;
  /** Old hostnames (comma separated) whose browser visits redirect to CANONICAL_ORIGIN. */
  LEGACY_HOSTS?: string;
  /** The app's public origin. Approval links use it ahead of APP_URL and the request origin. */
  CANONICAL_ORIGIN?: string;
};

export const RESOURCE_SERVER =
  "https://policy-desk.task-authority.demo/refunds";
export const SANDBOX_TTL_MINUTES = 15;
export const MAX_PENDING_APPROVALS = 10;
export const MAX_OPERATIONS_PER_GENERATION = 50;
export const MAX_ORDERS_PER_GENERATION = 40;
export const MAX_ACTIVE_SANDBOXES = 500;
export const DEFAULT_AGENT_ID = "agent_returns";
export const BANNER =
  "PUBLIC SANDBOX: real Auth0 login, MFA and approvals; simulated payments only. Your sandbox is deleted after 15 minutes.";

export class ConfigError extends Error {}
export const need = (env: Env, key: keyof Env): string => {
  const v = env[key];
  if (typeof v !== "string" || !v) throw new ConfigError(`Missing ${key}`);
  return v;
};
