import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTVerifyGetKey,
} from "jose";

export type MockCibaRequest = {
  authReqId: string;
  customerSubject: string;
  authorizationDetails: unknown[];
  status: "pending" | "approved" | "denied";
  /** When true, token response omits top-level authorization_details (Auth0-negative test). */
  omitTopLevelDetails?: boolean;
  /** When set, embed authorization_details only in the JWT (top-level omitted). */
  detailsInJwtOnly?: boolean;
  /** When set, duplicate authorization_details in JWT and top-level OAuth body. */
  detailsInJwtAlso?: boolean;
  /** When set with detailsInJwtAlso, JWT carries different details than top-level. */
  jwtDetailsMismatch?: boolean;
};

export type MockShoppingCibaProvider = {
  bcAuthorizeUrl: string;
  tokenUrl: string;
  issuer: string;
  audience: string;
  requests: Map<string, MockCibaRequest>;
  fetch: typeof fetch;
  mintAccessToken: (req: MockCibaRequest) => Promise<string>;
  decide: (authReqId: string, approve: boolean) => void;
  verifyKey: JWTVerifyGetKey;
};

export async function createMockShoppingCibaProvider(options?: {
  auth0Domain?: string;
}): Promise<MockShoppingCibaProvider> {
  const domain = options?.auth0Domain?.trim() || "ciba-mock.example";
  const issuer = `https://${domain}/`;
  const bcAuthorizeUrl = `https://${domain}/bc-authorize`;
  const tokenUrl = `https://${domain}/oauth/token`;
  const audience = "https://shopping-api.example";
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.alg = "RS256";
  jwk.kid = "ciba-mock";
  jwk.use = "sig";
  const requests = new Map<string, MockCibaRequest>();

  const mintAccessToken = async (req: MockCibaRequest) => {
    const now = Math.floor(Date.now() / 1000);
    const body: Record<string, unknown> = { scope: "openid" };
    if (req.detailsInJwtOnly || req.detailsInJwtAlso) {
      const details = req.jwtDetailsMismatch
        ? [{ type: "wrong", instruction: "mismatch" }]
        : req.authorizationDetails;
      body.authorization_details = details;
    }
    return new SignJWT(body)
      .setProtectedHeader({ alg: "RS256", kid: "ciba-mock" })
      .setSubject(req.customerSubject)
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = init?.method ?? "GET";
    const body = init?.body?.toString() ?? "";
    const params = new URLSearchParams(body);

    if (url === `${issuer}.well-known/jwks.json` && method === "GET") {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url === bcAuthorizeUrl && method === "POST") {
      const hint = JSON.parse(params.get("login_hint") ?? "{}") as {
        sub?: string;
      };
      const details = JSON.parse(
        params.get("authorization_details") ?? "[]",
      ) as unknown[];
      const authReqId = `mock_req_${requests.size + 1}`;
      requests.set(authReqId, {
        authReqId,
        customerSubject: hint.sub ?? "",
        authorizationDetails: details,
        status: "pending",
      });
      return new Response(
        JSON.stringify({
          auth_req_id: authReqId,
          expires_in: 3600,
          interval: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url === tokenUrl && method === "POST") {
      const id = params.get("auth_req_id") ?? "";
      const req = requests.get(id);
      if (!req) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      if (req.status === "pending") {
        return new Response(
          JSON.stringify({ error: "authorization_pending" }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      }
      requests.delete(id);
      if (req.status === "denied") {
        return new Response(JSON.stringify({ error: "access_denied" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      const access_token = await mintAccessToken(req);
      const json: Record<string, unknown> = {
        access_token,
        token_type: "Bearer",
        expires_in: 300,
      };
      if (!req.omitTopLevelDetails) {
        json.authorization_details = req.authorizationDetails;
      }
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
    });
  };

  const verifyKey = createLocalJWKSet({ keys: [jwk] });

  return {
    bcAuthorizeUrl,
    tokenUrl,
    issuer,
    audience,
    requests,
    fetch: fetchImpl,
    mintAccessToken,
    verifyKey,
    decide(authReqId, approve) {
      const req = requests.get(authReqId);
      if (!req) return;
      req.status = approve ? "approved" : "denied";
    },
  };
}
