import type { ShoppingIdentityEnv } from "../../../shopping-merchant/src/identity/config.js";
import type { MerchantLedgerEnv } from "../../../shopping-merchant/src/port-env.js";

export type ShoppingLiveEnv = MerchantLedgerEnv &
  ShoppingIdentityEnv & {
    ASSETS: Fetcher;
    CUSTOMER_STATE: DurableObjectNamespace;
    SHOPPING_AUTH0_CLIENT_ID?: string;
    SHOPPING_AUTH0_CLIENT_SECRET?: string;
    SHOPPING_SESSION_SECRET?: string;
    SHOPPING_PUBLIC_ORIGIN?: string;
    SHOPPING_BROWSER_AGENT_ID?: string;
    SHOPPING_MERCHANT_SHIPPING_ADDRESS_ID?: string;
    SHOPPING_MERCHANT_WALLET_MODE?: string;
    SHOPPING_MERCHANT_WALLET_LABEL?: string;
  };

export const MAX_CUSTOMER_SESSIONS = 8;
export const SESSION_COOKIE = "nsh_sid";
export const OAUTH_COOKIE = "nsh_oauth";
export const CSRF_HEADER = "x-nominee-csrf";
