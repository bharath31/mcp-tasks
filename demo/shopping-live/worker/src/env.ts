import type { ShoppingIdentityEnv } from "../../../shopping-merchant/src/identity/config.js";
import type { MerchantLedgerEnv } from "../../../shopping-merchant/src/port-env.js";
import type { ShoppingCibaEnv } from "../../../shopping-merchant/src/ciba/config.js";
import type { ShoppingAgentOrchestrationBindings } from "../../../shopping-agent-orchestration/src/types.js";
import type { WorkersAiBinding } from "@nominee/shopping-agent";

export type ShoppingLiveEnv = MerchantLedgerEnv &
  ShoppingIdentityEnv &
  Partial<ShoppingCibaEnv> &
  Partial<ShoppingAgentOrchestrationBindings> & {
    ASSETS: Fetcher;
    MERCHANT_LEDGER?: DurableObjectNamespace;
    CUSTOMER_STATE: DurableObjectNamespace;
    MERCHANT_ORIGIN?: string;
    AGENT_MODEL?: string;
    AI?: WorkersAiBinding;
    BROWSER?: Fetcher;
    AGENT_RUNS?: DurableObjectNamespace;
    SHOPPING_AUTH0_CLIENT_ID?: string;
    SHOPPING_AUTH0_CLIENT_SECRET?: string;
    SHOPPING_SESSION_SECRET?: string;
    SHOPPING_PUBLIC_ORIGIN?: string;
    SHOPPING_BROWSER_AGENT_ID?: string;
    SHOPPING_MERCHANT_SHIPPING_ADDRESS_ID?: string;
    SHOPPING_MERCHANT_SHIPPING_LABEL?: string;
    SHOPPING_MERCHANT_DISPLAY_NAME?: string;
    SHOPPING_MERCHANT_WALLET_MODE?: string;
    SHOPPING_MERCHANT_WALLET_LABEL?: string;
    /** Fail-closed unless explicitly enabled by operator after live Guardian confirmation. */
    SHOPPING_GUARDIAN_EXECUTE_ENABLED?: string;
    /** Test harness only — loopback fetcher for in-worker agent-browser HTTP. */
    SELF_SUBFETCH?: Fetcher;
  };

export const MAX_CUSTOMER_SESSIONS = 8;
export const SESSION_COOKIE = "nsh_sid";
export const OAUTH_COOKIE = "nsh_oauth";
export const CSRF_HEADER = "x-nominee-csrf";
