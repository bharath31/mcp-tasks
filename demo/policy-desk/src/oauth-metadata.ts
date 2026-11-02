// RFC 9728 protected-resource metadata for /mcp, so MCP hosts such as Claude Code can
// discover the Auth0 tenant and sign in on their own. The host sends the RFC 8707
// `resource` parameter (mcpResource) and gets a token whose audience is that resource.
import { mcpResource } from "./auth0.js";
import type { Host } from "./host.js";
import { json } from "./problem.js";

export const PRM_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
];

export function protectedResourceMetadata(host: Host) {
  const domain = (host.env.AUTH0_DOMAIN ?? "").replace(/\/$/, "");
  return json(
    {
      resource: mcpResource(host.env, host.origin),
      authorization_servers: domain ? [`https://${domain}/`] : [],
      scopes_supported: ["openid", "profile", "email", "offline_access"],
      bearer_methods_supported: ["header"],
      resource_name: "Policy Desk refunds",
      resource_documentation: `${host.origin}/`,
    },
    200,
    { "cache-control": "public, max-age=300" },
  );
}

/** WWW-Authenticate for a 401 on /mcp, pointing at the metadata above. */
export const mcpChallenge = (host: Host, error?: string) =>
  `Bearer resource_metadata="${host.origin}/.well-known/oauth-protected-resource/mcp"` +
  (error ? `, error="${error}"` : "");
