// DPoP (RFC 9449) proof check for the Worker's own endpoints (/sandbox/*, /v1/refunds*).
// Mirrors authenticate() in auth0/service/src/authn.ts: a token bound with cnf.jkt is
// only accepted with the DPoP scheme and a fresh, single-use proof for this request.
import {
  calculateJwkThumbprint,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWTPayload,
} from "jose";
import type { Db } from "../../../auth0/service/src/store.js";

async function sha256b64url(s: string) {
  const d = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
  );
  let bin = "";
  for (const b of d) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** True when the request may use this token: unbound Bearer, or bound DPoP with a valid proof. */
export async function dpopOk(
  db: Pick<Db, "query">,
  req: Request,
  token: string,
  payload: JWTPayload,
  now = Date.now(),
): Promise<boolean> {
  const scheme = req.headers.get("authorization")?.startsWith("DPoP ");
  const jkt = (payload.cnf as { jkt?: unknown } | undefined)?.jkt;
  if (jkt === undefined && !scheme) return true;
  try {
    if (typeof jkt !== "string" || !scheme) return false;
    const proof = req.headers.get("dpop");
    if (!proof) return false;
    const header = decodeProtectedHeader(proof);
    if (
      header.typ !== "dpop+jwt" ||
      !header.jwk ||
      "d" in header.jwk ||
      !["ES256", "RS256", "PS256"].includes(String(header.alg))
    )
      return false;
    if ((await calculateJwkThumbprint(header.jwk)) !== jkt) return false;
    const key = await importJWK(header.jwk, header.alg);
    const { payload: c } = await jwtVerify(proof, key, {
      algorithms: [String(header.alg)],
      currentDate: new Date(now),
      requiredClaims: ["iat", "jti"],
    });
    const target = new URL(req.url);
    target.search = "";
    target.hash = "";
    if (
      c.htm !== req.method ||
      c.htu !== target.href ||
      typeof c.iat !== "number" ||
      Math.abs(now / 1000 - c.iat) > 60 ||
      typeof c.jti !== "string" ||
      c.jti.length > 256 ||
      c.ath !== (await sha256b64url(token))
    )
      return false;
    // Proofs outside the +/-60s window can never replay: prune a bounded batch.
    await db.query(
      "delete from policy_desk.used_dpop_proofs where ctid in (select ctid from policy_desk.used_dpop_proofs where expires_at < $1 limit 100)",
      [new Date(now)],
    );
    const fresh = await db.query(
      "insert into policy_desk.used_dpop_proofs (jkt,jti,expires_at) values ($1,$2,$3) on conflict do nothing returning jti",
      [jkt, c.jti, new Date(now + 120_000)],
    );
    return !!fresh.rowCount;
  } catch {
    return false;
  }
}
