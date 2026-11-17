import assert from "node:assert/strict";
import { test } from "node:test";
import { createMerchantLedgerPorts } from "../src/merchant-ports.js";
import { createMerchantLedger } from "../src/ledger.js";
import { initMerchantSchema, createNodeSqlDatabase } from "../src/sql.js";
import { DatabaseSync } from "node:sqlite";
import { SIMULATED_WALLET_INITIAL_BALANCE_MINOR } from "../src/simulated-wallet/constants.js";
import { initializeTrustedSimulatedWalletOnce } from "../src/simulated-wallet/trusted-init.js";
import { ensureMerchantDemoShippingAddress } from "../src/customer-account/demo-address.js";
import { readSimulatedWalletBalanceMinor } from "../src/simulated-wallet/provision.js";

test("production ports: demo address, initial wallet once, fail-closed verifier", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = createNodeSqlDatabase(raw);
  initMerchantSchema(db);
  const customer = "cust-prod-1";
  ensureMerchantDemoShippingAddress(db, customer, {
    SHOPPING_MERCHANT_SHIPPING_ADDRESS_ID: "merchant-default",
  });
  initializeTrustedSimulatedWalletOnce(db, customer);
  initializeTrustedSimulatedWalletOnce(db, customer);
  assert.equal(
    readSimulatedWalletBalanceMinor(db, customer),
    SIMULATED_WALLET_INITIAL_BALANCE_MINOR,
  );

  const ports = createMerchantLedgerPorts(db, customer, {
    SHOPPING_MERCHANT_SHIPPING_ADDRESS_ID: "merchant-default",
  });
  assert.equal(
    await ports.verifyCustomerApproval({
      actor: { kind: "human", customerId: customer, scopes: [] },
      quote: {} as never,
    }),
    false,
  );
  const address = await ports.customerAccount.getAddress(
    customer,
    "merchant-default",
  );
  assert.ok(address?.trustedForAgentCheckout);

  const ledger = createMerchantLedger(db, ports, customer);
  const agent = {
    kind: "agent" as const,
    customerId: customer,
    agentId: "agent-1",
    pairwiseUserId: "u",
    sessionId: "s",
    scopes: ["cart:write", "checkout:write", "addresses:read"],
  };
  const cart = ledger.createCart(agent);
  ledger.updateCart(cart.id, agent, [
    { productId: "mug", quantity: 1, priceMinor: 1800, currency: "USD" },
  ]);
  const quote = await ledger.createQuote(cart.id, agent, "merchant-default");
  assert.equal(quote.totalMinor, 1800);
});
