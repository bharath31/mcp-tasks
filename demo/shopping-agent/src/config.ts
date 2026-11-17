import { z } from "zod";
import { STILLROOM_PRODUCT_IDS } from "./catalog.js";

const httpsOrigin = z
  .string()
  .url()
  .refine((u) => u.startsWith("https://"), "merchant origin must use HTTPS");

/** Host configuration; the model never supplies origins, selectors, or credentials. */
export const shoppingAgentConfig = z
  .object({
    merchantOrigin: httpsOrigin,
    /** Paths the host may load on the merchant origin (no query strings). */
    allowedPaths: z.array(z.string().regex(/^\//)).max(8).default(["/"]),
    productIds: z
      .array(z.enum(STILLROOM_PRODUCT_IDS))
      .min(1)
      .default([...STILLROOM_PRODUCT_IDS]),
    model: z.string().min(1).max(120).default("@cf/zai-org/glm-4.7-flash"),
    maxModelCalls: z.number().int().min(1).max(16).default(8),
    maxHostSteps: z.number().int().min(1).max(32).default(16),
    sessionTimeoutMs: z.number().int().min(5_000).max(600_000).default(120_000),
    temperature: z.number().min(0).max(1).default(0.2),
  })
  .strict();

export type ShoppingAgentConfig = z.infer<typeof shoppingAgentConfig>;

export function merchantHostname(config: ShoppingAgentConfig): string {
  return new URL(config.merchantOrigin).hostname;
}

export function trustedUrl(config: ShoppingAgentConfig, path: string): string {
  if (!config.allowedPaths.includes(path)) {
    throw new Error(`path not allowed: ${path}`);
  }
  const base = config.merchantOrigin.replace(/\/$/, "");
  return path === "/" ? `${base}/` : `${base}${path}`;
}