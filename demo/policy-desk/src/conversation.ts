// The refund agent's conversation, stored per sandbox generation so it survives tab
// switches, reloads and new browser tabs. The server owns the history the model reads:
// the browser sends only the new message, so it cannot plant assistant or tool messages.
import type { Db } from "../../../auth0/service/src/store.js";
import type { ChatMessage, TraceStep } from "./agent.js";
import { tenantIdOf, type Sandbox } from "./host.js";

export type ToolStep = Extract<TraceStep, { kind: "tool" }>;
/** What the chat shows: the visitor's messages and each agent reply with its tool calls. */
export type Turn =
  | { role: "user"; text: string }
  | {
      role: "agent";
      text: string;
      steps: ToolStep[];
      model?: string;
      failed?: boolean;
    };
export type Conversation = { history: ChatMessage[]; turns: Turn[] };

export async function loadConversation(
  db: Db,
  s: Sandbox,
): Promise<Conversation> {
  const r = await db.query(
    "select history, turns from policy_desk.agent_conversations where tenant_id = $1",
    [tenantIdOf(s)],
  );
  const row = r.rows[0];
  return row
    ? { history: row.history ?? [], turns: row.turns ?? [] }
    : { history: [], turns: [] };
}

/**
 * Appends one exchange in a single statement, so two tabs talking to the agent at
 * once both keep their messages instead of the later write replacing the earlier one.
 */
export async function appendConversation(
  db: Db,
  s: Sandbox,
  add: Conversation,
  now: number,
) {
  await db.query(
    `insert into policy_desk.agent_conversations (tenant_id, sandbox_id, history, turns, updated_at)
     values ($1, $2, $3::jsonb, $4::jsonb, $5)
     on conflict (tenant_id) do update set
       history = policy_desk.agent_conversations.history || excluded.history,
       turns = policy_desk.agent_conversations.turns || excluded.turns,
       updated_at = excluded.updated_at`,
    [
      tenantIdOf(s),
      s.id,
      JSON.stringify(add.history),
      JSON.stringify(add.turns),
      new Date(now).toISOString(),
    ],
  );
}

export async function clearConversation(db: Db, s: Sandbox) {
  await db.query(
    "delete from policy_desk.agent_conversations where tenant_id = $1",
    [tenantIdOf(s)],
  );
}
