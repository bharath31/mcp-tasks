import type { ModelPort, ModelRunInput, ParsedModelOutput } from "../ports.js";

/** Minimal Workers AI binding shape used by Policy Desk. */
export interface WorkersAiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export function createWorkersAiModel(ai: WorkersAiBinding): ModelPort {
  return {
    run: (model, input: ModelRunInput) =>
      ai.run(model, input as unknown as Record<string, unknown>),
    parseOutput: parseWorkersAiOutput,
  };
}

export function parseWorkersAiOutput(raw: unknown): ParsedModelOutput {
  const root = raw as Record<string, unknown>;
  const choice = (root.response ?? root) as Record<string, unknown>;
  const message =
    (choice.choices as { message?: Record<string, unknown> }[] | undefined)?.[0]
      ?.message ??
    (choice.message as Record<string, unknown> | undefined) ??
    choice;
  const content =
    typeof message?.content === "string" ? message.content : null;
  const toolCallsRaw = (message?.tool_calls ?? []) as {
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
  const toolCalls = toolCallsRaw
    .map((c) => ({
      id: String(c.id ?? ""),
      name: String(c.function?.name ?? ""),
      arguments: String(c.function?.arguments ?? "{}"),
    }))
    .filter((c) => c.id && c.name);
  return { content, toolCalls };
}