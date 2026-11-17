import { shoppingTestJwks } from "../../../../shopping-merchant/tests/support/identity-jwt.js";
import { createShoppingApp } from "../../src/app.js";
import { CustomerHostState } from "../../src/customer-state-do.js";
import { CustomerMerchantLedger } from "./merchant-do-shim.js";
import type { ShoppingLiveEnv } from "../../src/env.js";

const appPromise = shoppingTestJwks().then((jwks) =>
  createShoppingApp({ testVerifyKey: jwks }),
);

export { CustomerHostState, CustomerMerchantLedger };

export default {
  async fetch(req: Request, env: ShoppingLiveEnv): Promise<Response> {
    const app = await appPromise;
    return app.fetch(req, env);
  },
};