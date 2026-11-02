// LOCAL, standards-shaped OIDC provider for full-stack tests. NOT Auth0, and not a
// claim about Auth0 behaviour: it exists so the real SDK code paths (auth0-spa-js,
// @auth0/auth0-api-js discovery/JWKS/OBO, client credentials, CIBA polling) run over
// real HTTPS between real processes. Auth0-specific claims it emulates: org_id, amr,
// auth_time, authorization_details (RFC 9396).
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  decodeProtectedHeader,
  importJWK,
  calculateJwkThumbprint,
  type JWK,
} from "jose";

export type OidcUser = {
  key: string;
  sub: string;
  name: string;
  org: string;
  /** Optional: issued in the ID token as a verified email. */
  email?: string;
  /** RBAC roles, as post-login Actions see them in event.authorization.roles. */
  roles?: string[];
};
/** The subset of the Auth0 post-login Action API these tests exercise. */
export type PostLoginAction = {
  onExecutePostLogin: (event: any, api: any) => Promise<void>;
};
export type OidcClient = {
  id: string;
  secret?: string;
  permissions?: string[];
  redirectUris?: string[];
  metadata?: Record<string, string>;
};
export const MFA_CODE = "000000";

type Code = {
  user: OidcUser;
  client: string;
  redirect: string;
  nonce?: string;
  challenge?: string;
  audience?: string;
  org?: string;
  details: unknown[];
  mfaAt: number | null;
  /** The completed second factor, as the shipped Action names it in amr. */
  factor?: string;
  authTime: number;
  approvalChallenge?: string;
  scope?: string;
  /** Custom claims set by post-login Actions. */
  idClaims?: Record<string, unknown>;
  accessClaims?: Record<string, unknown>;
};
type Ciba = {
  user: OidcUser;
  audience: string;
  details: unknown[];
  message: string;
  status: "pending" | "approved" | "denied";
  mfa: boolean;
  polledAt: number;
};

export type OidcServer = {
  issuer: string;
  domain: string;
  caPath: string;
  jwk: JWK;
  privateJwk: JWK;
  server: Server;
  /** Test control: resolve a pending CIBA request as the end user would on a device. */
  cibaDecide(authReqId: string, approve: boolean, mfa?: boolean): boolean;
  cibaRequests: Map<string, Ciba>;
  close(): Promise<void>;
};

export function selfSignedCert() {
  const dir = mkdtempSync(join(tmpdir(), "oidc-cert-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      `${dir}/key.pem`,
      "-out",
      `${dir}/cert.pem`,
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  return {
    key: readFileSync(`${dir}/key.pem`),
    cert: readFileSync(`${dir}/cert.pem`),
    caPath: `${dir}/cert.pem`,
  };
}

export async function startOidcServer(cfg: {
  users: OidcUser[];
  clients: OidcClient[];
  resourceAudiences: string[];
  port?: number;
  /** Real Action modules (e.g. auth0/actions/*.cjs), run on each interactive sign-in. */
  postLoginActions?: PostLoginAction[];
}): Promise<OidcServer> {
  const { key, cert, caPath } = selfSignedCert();
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const jwk: JWK = {
    ...(await exportJWK(publicKey)),
    alg: "RS256",
    use: "sig",
    kid: "oidc-1",
  };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const codes = new Map<string, Code>();
  const cibaRequests = new Map<string, Ciba>();
  let issuer = "";

  const sign = (
    claims: Record<string, unknown>,
    aud: string,
    sub: string,
    ttl = 3600,
  ) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "oidc-1" })
      .setIssuer(issuer)
      .setAudience(aud)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .setJti(randomUUID())
      .sign(privateKey);

  const userToken = (
    u: OidcUser,
    o: {
      aud: string;
      client: string;
      org?: string;
      details?: unknown[];
      mfaAt?: number | null;
      factor?: string;
      authTime: number;
      approvalChallenge?: string;
      dpopJkt?: string;
      claims?: Record<string, unknown>;
    },
  ) =>
    sign(
      {
        ...o.claims,
        org_id: o.org ?? u.org,
        azp: o.client,
        amr: o.mfaAt ? ["pwd", "mfa", o.factor ?? "otp"] : ["pwd"],
        auth_time: o.mfaAt ?? o.authTime,
        ...(o.details?.length ? { authorization_details: o.details } : {}),
        ...(o.approvalChallenge
          ? {
              "https://task-authority.example/approval_challenge":
                o.approvalChallenge,
            }
          : {}),
        ...(o.dpopJkt ? { cnf: { jkt: o.dpopJkt } } : {}),
      },
      o.aud,
      u.sub,
    );

  const page = (title: string, body: string) =>
    `<!doctype html><meta charset=utf-8><title>${title}</title><body style="font:16px system-ui;max-width:520px;margin:40px auto"><h1>${title}</h1><p><em>Local test identity provider, not Auth0.</em></p>${body}`;
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

  const server = createServer({ key, cert }, async (req, res) => {
    const url = new URL(req.url ?? "/", issuer || "https://localhost");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const ct = String(req.headers["content-type"] ?? "");
    const params = new URLSearchParams(
      ct.includes("json") && raw
        ? Object.entries(JSON.parse(raw)).map(
            ([k, v]) =>
              [k, typeof v === "string" ? v : JSON.stringify(v)] as [
                string,
                string,
              ],
          )
        : raw,
    );
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers":
          "content-type,authorization,auth0-client,dpop",
        "access-control-max-age": "600",
      });
      return void res.end();
    }
    const send = (
      status: number,
      body: unknown,
      headers: Record<string, string> = {},
    ) => {
      res.writeHead(status, {
        "content-type":
          typeof body === "string"
            ? "text/html; charset=utf-8"
            : "application/json",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
        ...headers,
      });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const clientAuth = () => {
      let id = params.get("client_id") ?? "";
      let secret = params.get("client_secret") ?? "";
      const basic = String(req.headers.authorization ?? "").match(
        /^Basic (.+)$/,
      )?.[1];
      if (basic)
        [id, secret] = Buffer.from(basic, "base64").toString().split(":") as [
          string,
          string,
        ];
      const c = cfg.clients.find((x) => x.id === id);
      return c && (!c.secret || c.secret === secret) ? c : null;
    };

    try {
      if (url.pathname === "/.well-known/openid-configuration")
        return send(200, {
          issuer,
          authorization_endpoint: `${issuer}authorize`,
          token_endpoint: `${issuer}oauth/token`,
          jwks_uri: `${issuer}.well-known/jwks.json`,
          backchannel_authentication_endpoint: `${issuer}bc-authorize`,
          backchannel_token_delivery_modes_supported: ["poll"],
          grant_types_supported: [
            "authorization_code",
            "client_credentials",
            "urn:ietf:params:oauth:grant-type:token-exchange",
            "urn:openid:params:grant-type:ciba",
          ],
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: [
            "client_secret_post",
            "client_secret_basic",
            "none",
          ],
          code_challenge_methods_supported: ["S256"],
          authorization_details_types_supported: [
            "task_authority_approval",
            "agent_action",
          ],
        });
      if (url.pathname === "/.well-known/jwks.json")
        return send(200, { keys: [jwk] });

      if (url.pathname === "/authorize" && req.method === "GET") {
        const q = url.searchParams;
        if (q.get("prompt") === "none") {
          // Silent authentication (auth0-spa-js checkSession): this provider keeps no browser session.
          const msg = JSON.stringify({
            type: "authorization_response",
            response: {
              error: "login_required",
              error_description: "Login required",
              state: q.get("state"),
            },
          });
          if (q.get("response_mode") === "web_message")
            return send(
              200,
              `<!doctype html><script>parent.postMessage(${msg.replace(/</g, "\\u003c")}, ${JSON.stringify(new URL(q.get("redirect_uri") ?? "http://localhost").origin)});</script>`,
            );
          const back = new URL(q.get("redirect_uri") ?? "");
          back.searchParams.set("error", "login_required");
          if (q.get("state")) back.searchParams.set("state", q.get("state")!);
          res.writeHead(302, { location: back.toString() });
          return void res.end();
        }
        const details = q.get("authorization_details")
          ? (JSON.parse(q.get("authorization_details")!) as unknown[])
          : [];
        const stepUp =
          details.length > 0 ||
          q.get("max_age") === "0" ||
          Boolean(q.get("task_authority_challenge")) ||
          Boolean(q.get("acr_values"));
        const orgHint = q.get("organization") ?? "";
        const users = cfg.users.filter((u) => !orgHint || u.org === orgHint);
        const hidden = [...q.entries()]
          .map(
            ([k, v]) =>
              `<input type=hidden name="${esc(k)}" value="${esc(v)}">`,
          )
          .join("");
        return send(
          200,
          page(
            "Sign in",
            `<form method=post action="/authorize">${hidden}
          <label>Account <select name=_user>${users.map((u) => `<option value="${esc(u.key)}">${esc(u.name)} (${esc(u.org)})</option>`).join("")}</select></label>
          <p><label>Sign in with <select name=_method><option value=pwd>Password</option><option value=passkey>Passkey</option></select></label></p>
          ${stepUp ? `<p><label>Second factor code <input name=_mfa autocomplete=off></label></p><p><label>Factor <select name=_factor><option value=otp>One-time code</option><option value=webauthn-platform>Passkey (platform)</option><option value=webauthn-roaming>Security key</option></select></label></p><p>A fresh second factor is required for this action.</p>` : ""}
          <p><button type=submit>Continue</button></p></form>`,
          ),
        );
      }
      if (url.pathname === "/authorize" && req.method === "POST") {
        const q = params;
        const user = cfg.users.find((u) => u.key === q.get("_user"));
        const client = cfg.clients.find((c) => c.id === q.get("client_id"));
        const redirect = q.get("redirect_uri") ?? "";
        if (!user || !client || !client.redirectUris?.includes(redirect))
          return send(
            400,
            page("Error", "invalid client, user or redirect_uri"),
          );
        const details = q.get("authorization_details")
          ? (JSON.parse(q.get("authorization_details")!) as unknown[])
          : [];
        const stepUp =
          details.length > 0 ||
          q.get("max_age") === "0" ||
          Boolean(q.get("task_authority_challenge")) ||
          Boolean(q.get("acr_values"));
        const now = Math.floor(Date.now() / 1000);
        const method = ["passkey", "email"].includes(q.get("_method") ?? "")
          ? q.get("_method")!
          : "pwd";
        // A passkey is itself phishing-resistant, so it satisfies a step-up on its own.
        if (stepUp && method !== "passkey" && q.get("_mfa") !== MFA_CODE)
          return send(
            403,
            page("Second factor required", "The code was missing or wrong."),
          );
        const back = new URL(redirect);
        if (q.get("state")) back.searchParams.set("state", q.get("state")!);
        const idClaims: Record<string, unknown> = {};
        const accessClaims: Record<string, unknown> = {};
        let denied: string | null = null;
        const methods: { name: string; timestamp: string; type?: string }[] = [
          { name: method, timestamp: new Date(now * 1000).toISOString() },
        ];
        let actionQuery = Object.fromEntries(q.entries());
        for (const action of cfg.postLoginActions ?? []) {
          let challenge: string[] | undefined;
          await action.onExecutePostLogin(
            {
              client: { client_id: client.id, metadata: client.metadata },
              request: { query: actionQuery },
              transaction: {
                requested_scopes: (q.get("scope") ?? "").split(" "),
              },
              user: {
                user_id: user.sub,
                name: user.name,
                email: user.email,
                email_verified: Boolean(user.email),
                enrolledFactors: [{ type: q.get("_factor") ?? "otp" }],
              },
              authentication: { methods },
              authorization: { roles: user.roles ?? [] },
              secrets: {},
            },
            {
              access: {
                deny: (reason: string) => {
                  denied ??= reason;
                },
              },
              idToken: {
                setCustomClaim: (k: string, v: unknown) => (idClaims[k] = v),
              },
              accessToken: {
                setCustomClaim: (k: string, v: unknown) =>
                  (accessClaims[k] = v),
              },
              multifactor: { enable: () => {} },
              authentication: {
                challengeWith: (
                  factor: { type: string },
                  options?: { additionalFactors?: { type: string }[] },
                ) => {
                  challenge = [
                    factor,
                    ...(options?.additionalFactors ?? []),
                  ].map((item) => item.type);
                },
                enrollWithAny: (factors: { type: string }[]) => {
                  challenge = factors.map((factor) => factor.type);
                },
              },
            },
          );
          if (challenge && !denied) {
            const factor = q.get("_factor") ?? "otp";
            if (q.get("_mfa") !== MFA_CODE || !challenge.includes(factor))
              denied =
                "The requested WebAuthn second factor was not completed.";
            else {
              methods.push({
                name: "mfa",
                type: factor,
                timestamp: new Date(now * 1000).toISOString(),
              });
              // Auth0's MFA pause can replace request.query before the next Action.
              actionQuery = {};
            }
          }
          if (denied) break;
        }
        if (denied) {
          back.searchParams.set("error", "access_denied");
          back.searchParams.set("error_description", denied);
          res.writeHead(302, { location: back.toString() });
          return void res.end();
        }
        const code = randomUUID();
        codes.set(code, {
          user,
          client: client.id,
          redirect,
          nonce: q.get("nonce") ?? undefined,
          challenge: q.get("code_challenge") ?? undefined,
          audience: q.get("audience") ?? undefined,
          org: q.get("organization") ?? undefined,
          details,
          mfaAt: stepUp && method !== "passkey" ? now : null,
          factor: ["otp", "webauthn-platform", "webauthn-roaming"].includes(
            q.get("_factor") ?? "",
          )
            ? q.get("_factor")!
            : "otp",
          authTime: now,
          approvalChallenge: q.get("task_authority_challenge") ?? undefined,
          scope: q.get("scope") ?? undefined,
          idClaims,
          accessClaims,
        });
        back.searchParams.set("code", code);
        res.writeHead(302, { location: back.toString() });
        return void res.end();
      }

      if (url.pathname === "/oauth/token" && req.method === "POST") {
        const grant = params.get("grant_type");
        const client = clientAuth();
        if (!client) return send(401, { error: "invalid_client" });
        const now = Math.floor(Date.now() / 1000);
        if (grant === "authorization_code") {
          const c = codes.get(params.get("code") ?? "");
          codes.delete(params.get("code") ?? "");
          if (
            !c ||
            c.client !== client.id ||
            c.redirect !== params.get("redirect_uri")
          )
            return send(400, { error: "invalid_grant" });
          if (
            c.challenge &&
            createHash("sha256")
              .update(params.get("code_verifier") ?? "")
              .digest("base64url") !== c.challenge
          )
            return send(400, {
              error: "invalid_grant",
              error_description: "PKCE verification failed",
            });
          const aud = c.audience ?? cfg.resourceAudiences[0]!;
          let dpopJkt: string | undefined;
          if (typeof req.headers.dpop === "string") {
            try {
              const header = decodeProtectedHeader(req.headers.dpop);
              if (
                header.typ !== "dpop+jwt" ||
                header.alg !== "ES256" ||
                !header.jwk ||
                "d" in header.jwk
              )
                throw new Error("invalid_dpop_key");
              const proof = await jwtVerify(
                req.headers.dpop,
                await importJWK(header.jwk, "ES256"),
                {
                  algorithms: ["ES256"],
                  requiredClaims: ["iat", "jti", "htm", "htu"],
                  maxTokenAge: "5m",
                },
              );
              if (
                proof.payload.htm !== "POST" ||
                proof.payload.htu !== `${issuer}oauth/token`
              )
                throw new Error("invalid_dpop_target");
              dpopJkt = await calculateJwkThumbprint(header.jwk);
            } catch {
              return send(400, { error: "invalid_dpop_proof" });
            }
          }
          const base = {
            aud,
            client: client.id,
            org: c.org,
            details: c.details,
            mfaAt: c.mfaAt,
            factor: c.factor,
            authTime: c.authTime,
            approvalChallenge: c.approvalChallenge,
            dpopJkt,
            claims: c.accessClaims,
          };
          return send(200, {
            access_token: await userToken(c.user, base),
            token_type: dpopJkt ? "DPoP" : "Bearer",
            expires_in: 3600,
            scope: c.scope ?? "openid profile",
            id_token: await sign(
              {
                ...c.idClaims,
                nonce: c.nonce,
                org_id: c.org ?? c.user.org,
                auth_time: c.mfaAt ?? c.authTime,
                name: c.user.name,
                ...(c.user.email
                  ? { email: c.user.email, email_verified: true }
                  : {}),
              },
              client.id,
              c.user.sub,
            ),
          });
        }
        if (grant === "client_credentials") {
          const aud = params.get("audience") ?? cfg.resourceAudiences[0]!;
          return send(200, {
            access_token: await sign(
              {
                gty: "client-credentials",
                azp: client.id,
                permissions: client.permissions ?? [],
              },
              aud,
              `${client.id}@clients`,
            ),
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        if (grant === "urn:ietf:params:oauth:grant-type:token-exchange") {
          const subject = params.get("subject_token") ?? "";
          let claims: Record<string, unknown>;
          try {
            claims = (await jwtVerify(subject, jwks, { issuer })).payload;
          } catch {
            return send(400, {
              error: "invalid_grant",
              error_description: "subject_token rejected",
            });
          }
          if (claims.gty === "client-credentials")
            return send(400, {
              error: "invalid_grant",
              error_description: "human subject required",
            });
          const aud = params.get("audience") ?? cfg.resourceAudiences[0]!;
          const u = cfg.users.find((x) => x.sub === claims.sub);
          if (!u) return send(400, { error: "invalid_grant" });
          // On-behalf-of: same human, new audience. Assurance of the original login is preserved.
          const mfa = Array.isArray(claims.amr) && claims.amr.includes("mfa");
          return send(200, {
            access_token: await userToken(u, {
              aud,
              client: client.id,
              org: String(claims.org_id ?? u.org),
              mfaAt: mfa ? now : null,
              authTime: Number(claims.auth_time ?? now),
            }),
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        if (grant === "urn:openid:params:grant-type:ciba") {
          const id = params.get("auth_req_id") ?? "";
          const r = cibaRequests.get(id);
          if (!r) return send(400, { error: "invalid_grant" });
          if (r.status === "pending")
            return send(400, { error: "authorization_pending" });
          cibaRequests.delete(id);
          if (r.status === "denied")
            return send(400, { error: "access_denied" });
          return send(200, {
            access_token: await userToken(r.user, {
              aud: r.audience,
              client: client.id,
              details: r.details,
              mfaAt: r.mfa ? now : null,
              authTime: now,
            }),
            token_type: "Bearer",
            expires_in: 300,
          });
        }
        return send(400, { error: "unsupported_grant_type" });
      }

      if (url.pathname === "/bc-authorize" && req.method === "POST") {
        const client = clientAuth();
        if (!client) return send(401, { error: "invalid_client" });
        const hint = JSON.parse(params.get("login_hint") ?? "{}") as {
          sub?: string;
        };
        const user = cfg.users.find((u) => u.sub === hint.sub);
        if (!user) return send(400, { error: "unknown_user_id" });
        const id = `ciba_${randomUUID()}`;
        cibaRequests.set(id, {
          user,
          audience: params.get("audience") ?? cfg.resourceAudiences[0]!,
          details: params.get("authorization_details")
            ? JSON.parse(params.get("authorization_details")!)
            : [],
          message: params.get("binding_message") ?? "",
          status: "pending",
          mfa: false,
          polledAt: 0,
        });
        return send(200, { auth_req_id: id, expires_in: 120, interval: 1 });
      }
      send(404, { error: "not_found" });
    } catch (e) {
      send(500, {
        error: "server_error",
        error_description: e instanceof Error ? e.message : "unknown",
      });
    }
  });
  await new Promise<void>((r) => server.listen(cfg.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  issuer = `https://localhost:${port}/`;
  return {
    issuer,
    domain: `localhost:${port}`,
    caPath,
    jwk,
    privateJwk: await exportJWK(privateKey),
    server,
    cibaRequests,
    cibaDecide(id, approve, mfa = true) {
      const r = cibaRequests.get(id);
      if (!r) return false;
      r.status = approve ? "approved" : "denied";
      r.mfa = mfa;
      return true;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
