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

/** Normalizes Workers AI output (OpenAI-style `choices` and legacy top-level fields). */
export function parseModelOutput(out: unknown): ParsedModelOutput {
  const root = out as Record<string, unknown>;
  const msg = (
    root?.choices as { message?: Record<string, unknown> }[] | undefined
  )?.[0]?.message;
  const rawCalls: unknown[] =
    (msg?.tool_calls as unknown[] | undefined) ??
    (root?.tool_calls as unknown[] | undefined) ??
    [];
  const toolCalls = rawCalls
    .map((c, i) => {
      const call = c as Record<string, unknown>;
      const fn = call.function as Record<string, unknown> | undefined;
      const name = fn?.name ?? call.name;
      const args = fn?.arguments ?? call.arguments ?? {};
      return typeof name === "string"
        ? {
            id: String(
              call.id ?? `call_${i}_${crypto.randomUUID().slice(0, 8)}`,
            ),
            name,
            arguments: typeof args === "string" ? args : JSON.stringify(args),
          }
        : null;
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const contentRaw = msg?.content ?? root.response ?? null;
  return {
    content:
      typeof contentRaw === "string" && contentRaw.trim() ? contentRaw : null,
    toolCalls,
  };
}

export function parseWorkersAiOutput(raw: unknown): ParsedModelOutput {
  const root = raw as Record<string, unknown>;
  const inner = root.response ?? root;
  return parseModelOutput(inner);
}
