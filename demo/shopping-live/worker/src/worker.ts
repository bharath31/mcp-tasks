import { ShoppingAgentRunState } from "../../../shopping-agent-orchestration/src/agent-run-do.js";
import { CustomerMerchantLedger } from "./merchant-do-binding.js";
import { CustomerHostState } from "./customer-state-do.js";
import { createShoppingApp } from "./app.js";
import type { ShoppingLiveEnv } from "./env.js";

const app = createShoppingApp();

export { CustomerHostState, CustomerMerchantLedger, ShoppingAgentRunState };

export default {
  fetch(
    req: Request,
    env: ShoppingLiveEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return app.fetch(req, env, ctx);
  },
};
