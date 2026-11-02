// MCP entry authentication: the real Auth0 SDK for APIs (@auth0/auth0-api-js),
// not an application-issued opaque token. Also publishes RFC 9728 metadata.
import {
  ApiClient,
  BearerMethod,
  ProtectedResourceMetadataBuilder,
} from "@auth0/auth0-api-js";

export type Principal = {
  sub: string;
  orgId: string;
  clientId: string;
  /** Agent identity mapped from the verified client id; never from tool arguments. */
  agentId: string;
  actorType?: "human" | "agent";
  /** The MCP-audience token. Exchanged (OBO) before it is shown to Task Authority. */
  accessToken: string;
};

export class AuthRequired extends Error {
  constructor(
    readonly code: "invalid_token" | "missing_token" | "insufficient_context",
    message: string,
  ) {
    super(message);
  }
}

export type AuthOptions = {
  domain: string;
  /** Audience (resource indicator) of this MCP server. */
  audience: string;
  /** Verified client id -> registered agent id. Unmapped clients are refused. */
  agentByClient: Record<string, string>;
  /** Explicit registered human CLI/UI clients, validated from the verified token azp. */
  humanClientIds?: string[];
  /** Public base URL of this MCP resource server. */
  resource: string;
  customFetch?: typeof fetch;
  /** Confidential-client credentials enable on-behalf-of exchange. */
  clientId?: string;
  clientSecret?: string;
  /** Task Authority audience for the exchanged subject token. */
  authorityAudience: string;
  /** Test seam / alternative to OBO. */
  exchange?: (principal: Principal) => Promise<string>;
};

export class McpAuthenticator {
  private api: ApiClient;
  constructor(private o: AuthOptions) {
    this.api = new ApiClient({
      domain: o.domain,
      audience: o.audience,
      clientId: o.clientId,
      clientSecret: o.clientSecret,
      customFetch: o.customFetch,
      dpop: { mode: "disabled" },
    });
  }
  metadataUrl() {
    return `${this.o.resource.replace(/\/$/, "")}/.well-known/oauth-protected-resource`;
  }
  metadata() {
    return new ProtectedResourceMetadataBuilder(this.o.resource, [
      `https://${this.o.domain}/`,
    ])
      .withBearerMethodsSupported([BearerMethod.HEADER])
      .build()
      .toJSON();
  }
  challenge(error?: string) {
    return `Bearer resource_metadata="${this.metadataUrl()}"${error ? `, error="${error}"` : ""}`;
  }
  async authenticate(request: Request): Promise<Principal> {
    const token = request.headers
      .get("authorization")
      ?.match(/^Bearer (\S+)$/)?.[1];
    if (!token)
      throw new AuthRequired("missing_token", "Bearer token required.");
    let claims;
    try {
      claims = await this.api.verifyAccessToken({
        accessToken: token,
        requiredClaims: ["sub"],
      });
    } catch {
      throw new AuthRequired("invalid_token", "Access token rejected.");
    }
    const orgId = typeof claims.org_id === "string" ? claims.org_id : undefined;
    const clientId = String(claims.azp ?? claims.client_id ?? "");
    const agentId = this.o.agentByClient[clientId];
    const human =
      this.o.humanClientIds?.includes(clientId) &&
      !claims.act &&
      claims.sub_profile !== "ai_agent" &&
      !String(claims.sub).endsWith("@clients");
    if (!orgId || (!agentId && !human))
      throw new AuthRequired(
        "insufficient_context",
        "Token needs an organization and a registered agent client.",
      );
    return {
      sub: String(claims.sub),
      orgId,
      clientId,
      agentId: human ? "human_direct" : agentId!,
      actorType: human ? "human" : "agent",
      accessToken: token,
    };
  }
  /** Token for the Task Authority audience, preserving the end user's identity. */
  async subjectToken(p: Principal): Promise<string> {
    if (this.o.exchange) return this.o.exchange(p);
    const r = await this.api.getTokenOnBehalfOf(p.accessToken, {
      audience: this.o.authorityAudience,
    });
    return r.accessToken;
  }
}
