import type { AgentToolStep, Api, Info, Me } from "./types";

export type Section = "agent" | "reviews" | "policy" | "audit" | "glossary";

export type Ctx = {
  api: Api;
  me: Me;
  info: Info;
  /** Operation highlighted by the guide or by a cross-link. */
  focusOp?: string;
  /** A message to send to the agent when the Agent view opens (e.g. "it was approved, check on it"). */
  agentPrompt?: string;
  /** The agent's MCP calls from this visit, by operation id, so Audit can show the wire exchange. */
  runs: Map<string, AgentToolStep>;
  go(section: Section, focusOp?: string): void;
  flash(message: string, kind?: "" | "bad" | "ok"): void;
  /** Real state changed: recompute guide progress and limits. */
  changed(): void;
  relogin(): void;
};
