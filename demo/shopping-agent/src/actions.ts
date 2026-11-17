import { z } from "zod";
import { STILLROOM_PRODUCT_IDS } from "./catalog.js";

/** Discriminated union of host-executable actions the model may request via tools. */
export const hostAction = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("navigate"),
      path: z.string().regex(/^\//).max(200),
      hash: z
        .string()
        .regex(/^#[a-z]+$/)
        .max(32)
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal("view_catalog") }).strict(),
  z
    .object({
      kind: z.literal("add_to_cart"),
      productId: z.enum(STILLROOM_PRODUCT_IDS),
    })
    .strict(),
  z.object({ kind: z.literal("view_cart") }).strict(),
  z
    .object({
      kind: z.literal("stop"),
      summary: z.string().trim().min(1).max(500),
    })
    .strict(),
]);

export type HostAction = z.infer<typeof hostAction>;

const toolCall = z.object({
  id: z.string().max(100),
  type: z.literal("function").default("function"),
  function: z.object({
    name: z.string().max(64),
    arguments: z.string().max(2000),
  }),
});

export const modelToolCall = toolCall;

/** Map model-facing tool names to validated host actions. */
export function actionFromToolCall(name: string, argsJson: string): HostAction {
  const parsed: unknown = JSON.parse(argsJson);
  switch (name) {
    case "navigate_shop":
      return hostAction.parse({
        kind: "navigate",
        ...z
          .object({
            path: z.string().regex(/^\//).default("/"),
            hash: z
              .string()
              .regex(/^#[a-z]+$/)
              .optional(),
          })
          .strict()
          .parse(parsed),
      });
    case "view_catalog":
      return hostAction.parse({ kind: "view_catalog" });
    case "add_to_cart": {
      const { productId } = z
        .object({ productId: z.enum(STILLROOM_PRODUCT_IDS) })
        .strict()
        .parse(parsed);
      return hostAction.parse({ kind: "add_to_cart", productId });
    }
    case "view_cart":
      return hostAction.parse({ kind: "view_cart" });
    case "finish_session": {
      const { summary } = z
        .object({ summary: z.string().trim().min(1).max(500) })
        .strict()
        .parse(parsed);
      return hostAction.parse({ kind: "stop", summary });
    }
    default:
      throw new Error(`tool not permitted: ${name}`);
  }
}

export const AGENT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "navigate_shop",
      description:
        "Open an allowed shop path on the configured merchant origin (path only, optional hash like #shop or #cart).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path beginning with /" },
          hash: { type: "string", description: "Optional in-page anchor" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "view_catalog",
      description:
        "Read the sanitized product catalog visible on the shop page.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "add_to_cart",
      description: "Add one unit of a catalog product to the cart.",
      parameters: {
        type: "object",
        properties: {
          productId: { type: "string", enum: [...STILLROOM_PRODUCT_IDS] },
        },
        required: ["productId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "view_cart",
      description:
        "Read a sanitized summary of cart line items (no checkout actions).",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "finish_session",
      description:
        "Stop after cart updates; never completes checkout or enters payment.",
      parameters: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
        additionalProperties: false,
      },
    },
  },
] as const;

export const PERMITTED_TOOL_NAMES: ReadonlySet<string> = new Set(
  AGENT_TOOLS.map((t) => t.function.name),
);
