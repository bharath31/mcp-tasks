// Signed warehouse event ingress. A synthetic producer in this reference
// implementation (see README); the verification code is the production shape.
import { z } from "zod";

export const warehouseEventSchema = z
  .object({
    eventId: z
      .string()
      .min(8)
      .max(100)
      .regex(/^[A-Za-z0-9_\-.:]+$/),
    type: z.literal("return.received"),
    orgId: z.string().min(1).max(100),
    orderId: z.string().min(1).max(80),
    paymentId: z.string().min(1).max(100),
    reference: z.string().min(1).max(120),
  })
  .strict();
export type WarehouseEvent = z.infer<typeof warehouseEventSchema>;

const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)),
  );
}
export async function signWarehouseBody(
  secret: string,
  body: string,
  timestampSec: number,
) {
  return `t=${timestampSec},v1=${await hmac(secret, `${timestampSec}.${body}`)}`;
}
const equal = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

export async function verifyWarehouseRequest(
  secret: string,
  header: string | null,
  body: string,
  nowMs: number,
  toleranceSec = 300,
) {
  const m = header?.match(/^t=(\d{10}),v1=([a-f0-9]{64})$/);
  if (!m) return null;
  if (Math.abs(nowMs / 1000 - Number(m[1])) > toleranceSec) return null;
  if (!equal(await hmac(secret, `${m[1]}.${body}`), m[2]!)) return null;
  const parsed = warehouseEventSchema.safeParse(safeJson(body));
  return parsed.success ? parsed.data : null;
}
const safeJson = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};
