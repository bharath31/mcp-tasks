// Fixed-window limits kept in Postgres so they hold across isolates.
// IPs are hashed with a salt before storage.
import type { Db } from "../../../auth0/service/src/store.js";
import type { Env } from "./env.js";

export class LimitExceeded extends Error {
  constructor(readonly retryAfterSec: number) {
    super("rate_limited");
  }
}
export async function hashIp(env: Env, req: Request) {
  const ip =
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "local";
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${env.IP_HASH_SALT ?? "policy-desk"}|${ip}`),
  );
  return [...new Uint8Array(bytes)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export async function limit(
  db: Db,
  key: string,
  max: number,
  windowSec: number,
  now = Date.now(),
) {
  const window = Math.floor(now / 1000 / windowSec);
  const r = await db.query<{ count: number }>(
    `insert into policy_desk.rate_limits (key, window_start, count) values ($1,$2,1)
     on conflict (key, window_start) do update set count = policy_desk.rate_limits.count + 1
     returning count`,
    [key, window * windowSec],
  );
  if (Number(r.rows[0]!.count) > max)
    throw new LimitExceeded(
      Math.max(1, (window + 1) * windowSec - Math.floor(now / 1000)),
    );
}
