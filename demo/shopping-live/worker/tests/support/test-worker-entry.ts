import { ShoppingAgentRunState } from "../../../../shopping-agent-orchestration/src/agent-run-do.js";
import { shoppingTestJwks } from "../../../../shopping-merchant/tests/support/identity-jwt.js";
import { createShoppingApp } from "../../src/app.js";
import { CustomerHostState } from "../../src/customer-state-do.js";
import type { ShoppingLiveEnv } from "../../src/env.js";
import { CustomerMerchantLedger } from "./merchant-do-shim.js";
import { handleTestMintAgentCap } from "./mint-agent-cap.js";
import { handleTestRevokeAgentCap } from "./revoke-agent-cap.js";
import { handleTestExpireQuote } from "./expire-quote-for-test.js";
import { handleTestCibaUnbridged } from "./ciba-unbridged-for-test.js";
import { handleTestProbeForbiddenLedgerOps } from "./probe-forbidden-ledger-ops.js";
import { handleTestSeedSession } from "./seed-session.js";
import { harnessAgentPorts } from "./test-agent-ports.js";
const appPromise = shoppingTestJwks().then((jwks) =>
  createShoppingApp({
    testVerifyKey: jwks,
    agentPorts: harnessAgentPorts,
    awaitAgentRunInRequest: true,
  }),
);

export { CustomerHostState, CustomerMerchantLedger, ShoppingAgentRunState };

export default {
  async fetch(req: Request, env: ShoppingLiveEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/test/seed-session" && req.method === "POST") {
      const jwks = await shoppingTestJwks();
      return handleTestSeedSession(req, env, { testVerifyKey: jwks });
    }
    if (url.pathname === "/test/mint-agent-cap" && req.method === "POST") {
      return handleTestMintAgentCap(req, env);
    }
    if (url.pathname === "/test/revoke-agent-cap" && req.method === "POST") {
      return handleTestRevokeAgentCap(req, env);
    }
    if (url.pathname === "/test/expire-quote" && req.method === "POST") {
      return handleTestExpireQuote(req, env);
    }
    if (url.pathname === "/test/ciba-unbridged" && req.method === "POST") {
      return handleTestCibaUnbridged(req, env);
    }
    if (
      url.pathname === "/test/probe-forbidden-ledger-ops" &&
      req.method === "POST"
    ) {
      return handleTestProbeForbiddenLedgerOps(req, env);
    }
    const app = await appPromise;
    return app.fetch(req, env);
  },
};
