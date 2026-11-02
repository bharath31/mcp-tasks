// UI-side model. api.ts is the only place that maps wire shapes onto these.
export type Me = {
  sub: string;
  name: string;
  email?: string;
  sandboxId?: string;
  role?: string;
  /** False until the visitor creates their sandbox. */
  initialized: boolean;
  /** What the current access token proves. */
  token?: { amr: string[]; dpopBound: boolean; authTime?: number };
};

/** The agent is a separate, server-side machine identity. The visitor never acts as it. */
export type AgentInfo = {
  name: string;
  subject: string;
  role?: string;
  /** Workers AI model id behind the agent. */
  model?: string;
  /** False when the server has no model binding. */
  available?: boolean;
};

export type Limits = {
  maxPending?: number;
  sandboxTtlMinutes?: number;
  maxOperations?: number;
  maxPolicyPublishesPerHour?: number;
  sandboxExpiresAt?: string;
};

export type Budget = {
  usedMinor: number;
  maxMinor: number;
  usedCount: number;
  maxCount: number;
};

export type Info = {
  banner?: string;
  limits: Limits;
  agent: AgentInfo;
  resourceServer: string;
};

/** Chat history in the OpenAI-compatible shape the server keeps for the model. */
export type ChatMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

/** One MCP JSON-RPC exchange exactly as it went over the wire. */
export type McpExchange = {
  request: { method: string; params: Record<string, unknown> };
  status: number;
  response: unknown;
};
export type AgentTask = {
  taskId: string;
  status: string;
  statusMessage?: string;
  decision?: {
    decision?: string | null;
    reasonCode?: string | null;
    tier?: string | null;
    ruleIds?: string[];
    policyVersion?: string | null;
    reviewUrl?: string;
  };
};
export type AgentToolStep = {
  kind: "tool";
  callId: string;
  tool: string;
  arguments: Record<string, unknown>;
  exchanges: McpExchange[];
  isError: boolean;
  task?: AgentTask;
  /** Server-side time for the tool call, including every MCP exchange. */
  ms?: number;
};
export type AgentStep =
  | { kind: "model"; text: string | null; toolCalls: string[]; ms?: number }
  | AgentToolStep;
/** Live progress of one agent turn, streamed as the server works. */
export type AgentEvent =
  | { type: "model_start"; n: number }
  | { type: "model_done"; n: number; step: AgentStep }
  | {
      type: "tool_start";
      callId: string;
      tool: string;
      arguments: Record<string, unknown>;
    }
  | { type: "tool_done"; step: AgentToolStep };
/** One line of the "under the hood" timeline: a model call or an MCP tool call. */
export type AgentBeat = {
  kind: "model" | "tool";
  label: string;
  detail?: string;
  /** Set once finished; until then the line shows a live timer from startedAt. */
  ms?: number;
  startedAt?: number;
  outcome?: "allow" | "approve" | "deny" | "info";
};
/** One entry of the chat as the server stores it. */
export type ChatTurn =
  | { role: "user"; text: string }
  | {
      role: "agent";
      text: string;
      steps: AgentToolStep[];
      model?: string;
      failed?: boolean;
      /** This page's timeline of the turn, model calls included (the server keeps tool steps). */
      beats?: AgentBeat[];
      ms?: number;
    };
export type AgentTurn = {
  model: string;
  reply: string;
  /** Messages the server added to the model's history. */
  messages: ChatMessage[];
  trace: AgentStep[];
  /** The two chat entries (your message and the reply) the server stored. */
  turns: ChatTurn[];
  usage: { inputTokens: number; outputTokens: number; modelCalls: number };
};

export type AuditEvent = {
  at: string;
  type: string;
  actorChain: string[];
  policyVersion?: string;
  ruleIds?: string[];
  detail?: string;
  /** The reviewer's optional note on their decision. */
  reviewerReason?: string;
};

export type Operation = {
  id: string;
  state: string;
  action: string;
  resource: string;
  amountMinor?: number;
  currency?: string;
  customer?: string;
  item?: string;
  reason?: string;
  requester: string;
  tier?: string;
  /** The tier's assurance from the operation's policy snapshot. */
  assurance?: "session_mfa" | "per_operation";
  /** Factors the tier accepts, from the policy snapshot (for example webauthn-platform, otp). */
  factors?: string[];
  ruleIds?: string[];
  decision?: string;
  reasonCode?: string;
  policyVersion?: string;
  createdAt: string;
  digest?: string;
  quorum?: { required: number; have: number };
  approvalId?: string;
};

export type ApprovalItem = {
  id: string;
  operation: Operation;
  tier: string;
  digest: string;
  expiresAt?: string;
  lease?: { mine: boolean; expiresAt: string };
  /** What the tier asks of you, from the policy snapshot, not from this UI. */
  assurance: "session_mfa" | "per_operation";
  /** The tier also accepts a fresh authenticator-app code (the sandbox's demo setting). */
  appCodeAccepted: boolean;
};

export type DecisionItem = {
  approvalId: string;
  operationId?: string;
  /** Approving a per_operation tier: needs a service challenge and a WebAuthn re-authentication. */
  highValue?: boolean;
  /** The tier also accepts an authenticator-app code, so Auth0 may offer one. */
  appCodeAccepted?: boolean;
  decision: "approve" | "reject";
  digest: string;
  /** Optional reviewer note, recorded in the audit trail. */
  reason?: string;
  /** Shown on the way to Auth0, so the reviewer knows what they are confirming. */
  summary?: string;
};

export type DecisionResult = {
  ok: boolean;
  status: number;
  code?: string;
  message: string;
  /** True when the browser is being sent to Auth0 to re-authenticate. */
  redirecting?: boolean;
  /** The operation decided, so the console can hand it back to the agent. */
  operationId?: string;
  decision?: "approve" | "reject";
};

/** One request the console made, with the server's own account of where the time went. */
export type Activity = {
  id: number;
  method: string;
  path: string;
  status?: number;
  startedAt: number;
  ms?: number;
  /** Parsed Server-Timing: total, connect, db, fga, model. */
  server?: Record<string, { ms: number; desc?: string }>;
  failed?: boolean;
};

export type PolicySettings = {
  agentAutoLimitMinor: number;
  budgetMaxMinor: number;
  budgetMaxCount: number;
  highValueAboveMinor: number;
  /** Demo setting: routine approvals also accept a fresh authenticator-app code. */
  allowAuthenticatorApp?: boolean;
};
export type NumericPolicyKey = Exclude<
  keyof PolicySettings,
  "allowAuthenticatorApp"
>;
export type PolicyView = {
  resourceServer: string;
  version: string;
  settings: PolicySettings;
  summary: { id: string; tier?: string; when?: string | null; text: string }[];
  envelope: Record<NumericPolicyKey, [number, number]>;
  /** Versions published in the last hour, against the sandbox's hourly cap. */
  publishes?: { used: number; max: number };
  /** The full document when the token may read it; otherwise absent. */
  document?: unknown;
};

export type Progress = {
  signedIn: boolean;
  policyPublished: boolean;
  autoAllowedRefund: boolean;
  approvalRequestedRefund: boolean;
  approvedWithStepUp: boolean;
  eventsPresent: boolean;
  policyEdited: boolean;
};

export type SimulationResult = {
  considered: number;
  changed: number;
  rows: {
    operationId: string;
    summary: string;
    before: string;
    after: string;
  }[];
};

export type Resumed = { kind: "decision"; result: DecisionResult };

/** Whether a visitor's own agent (Claude Code, any MCP client) holds a key for this sandbox. */
export type AgentKeyStatus = {
  available: boolean;
  connected: boolean;
  mcpUrl: string;
  expiresAt?: string;
  lastUsedAt?: string;
};
/** A freshly issued agent key. The token is shown once and never stored by the page. */
export type AgentKey = {
  token: string;
  expiresAt: string;
  mcpUrl: string;
  claudeCode: string;
  mcpJson: unknown;
};

export interface Api {
  me(): Promise<Me>;
  info(): Promise<Info>;
  /** One agent turn: the server adds the message to the stored conversation and runs the model. */
  agent(message: string, onEvent?: (e: AgentEvent) => void): Promise<AgentTurn>;
  /** The stored conversation of this sandbox. */
  conversation(): Promise<ChatTurn[]>;
  /** Starts a new conversation. */
  clearConversation(): Promise<void>;
  agentKey(): Promise<AgentKeyStatus>;
  /** Issues a key bound to this sandbox; any earlier key stops working. */
  connectAgent(): Promise<AgentKey>;
  disconnectAgent(): Promise<void>;
  state(): Promise<{ operations: Operation[]; budget?: Budget }>;
  audit(operationId: string): Promise<AuditEvent[]>;
  queue(): Promise<ApprovalItem[]>;
  /** Starts loading the review queue ahead of a visit to Reviews. */
  prefetchQueue(): void;
  lease(approvalId: string): Promise<void>;
  decide(items: DecisionItem[]): Promise<DecisionResult>;
  /** After a real re-authentication redirect, replay the decision that triggered it. */
  resumePending(): Promise<Resumed | undefined>;
  progress(): Promise<Progress>;
  policy(): Promise<PolicyView>;
  /** Publishes and activates a new version through the real policy API. */
  savePolicy(change: Partial<PolicySettings>): Promise<string>;
  restorePolicy(): Promise<string>;
  simulate(thresholdMinor: number): Promise<SimulationResult>;
  /** allowAuthenticatorApp: start with authenticator-app approvals for routine refunds. */
  reset(opts?: { allowAuthenticatorApp?: boolean }): Promise<void>;
  signOut(): Promise<void>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAfterSec?: number,
    readonly hint?: string,
    readonly nextAction?: string,
  ) {
    super(message);
  }
}
