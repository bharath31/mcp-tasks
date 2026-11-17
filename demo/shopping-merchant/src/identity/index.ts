export {
  normalizeShoppingIdentity,
  parseApiAudience,
  parseAuth0Domain,
  SHOPPING_CUSTOMER_SCOPE,
  shoppingIdentityConfigured,
  shoppingIssuer,
  requireShoppingIdentity,
  type ShoppingIdentityEnv,
} from "./config.js";
export {
  customerBearerToken,
  verifyCustomerAccessToken,
  verifiedCustomerAsHumanActor,
  type CustomerAccessTokenDeps,
  type VerifiedCustomer,
} from "./customer-access-token.js";
export {
  AGENT_SESSION_SCOPES,
  AgentSessionConfigError,
  createAgentSessionService,
  MAX_AGENT_SESSION_TTL_MS,
  type AgentSessionGrant,
  type AgentSessionOptions,
  type AgentSessionService,
  type AgentSessionStore,
} from "./agent-session.js";
