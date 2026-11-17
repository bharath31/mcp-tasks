import type {
  CustomerAccountPort,
  CustomerApprovalVerifier,
  OrderProviderPort,
  Quote,
} from "../../src/types.js";

const addresses = [
  {
    id: "fixture-home",
    customerId: "fixture-customer",
    label: "Home (fixture)",
    version: "1",
    trustedForAgentCheckout: true,
    destination: { country: "US", postalCode: "10001" },
  },
  {
    id: "fixture-alternate",
    customerId: "fixture-customer",
    label: "Alternate (fixture)",
    version: "1",
    trustedForAgentCheckout: false,
    destination: { country: "US", postalCode: "94105" },
  },
] as const;

export function createFixtureCustomerAccount(): CustomerAccountPort {
  return {
    async getAddress(customerId, addressId) {
      const hit = addresses.find(
        (a) => a.customerId === customerId && a.id === addressId,
      );
      return hit ? structuredClone(hit) : null;
    },
  };
}

const approvalKey = (quote: Quote) =>
  `${quote.id}:${quote.operationId}:${quote.revision}:${quote.customerId}`;

/** Test-only approval simulator; not identity proof and not for production. */
export function createFixtureApprovalVerifier(): CustomerApprovalVerifier & {
  approveForTest(quote: Quote): void;
} {
  const approved = new Set<string>();
  const verify: CustomerApprovalVerifier = async ({ quote }) =>
    approved.has(approvalKey(quote));
  return Object.assign(verify, {
    approveForTest(quote: Quote) {
      approved.add(approvalKey(quote));
    },
  });
}

export type FixtureOrderProvider = OrderProviderPort & {
  getPlaceCalls(): number;
  configurePlace(mode: "success" | "null" | "throw" | "slow"): void;
  seedOrder(idempotencyKey: string, id?: string): void;
  configureReconcileAbsent(idempotencyKey: string, absent: boolean): void;
};

/** In-memory simulated order provider; never charges; not restart-durable. Test bundle only. */
export function createFixtureOrderProvider(): FixtureOrderProvider {
  const orders = new Map<string, { id: string }>();
  const reconcileAbsent = new Set<string>();
  let placeMode: "success" | "null" | "throw" | "slow" = "success";
  let placeCalls = 0;
  return {
    getPlaceCalls() {
      return placeCalls;
    },
    configurePlace(mode) {
      placeMode = mode;
    },
    seedOrder(idempotencyKey: string, id = crypto.randomUUID()) {
      orders.set(idempotencyKey, { id });
    },
    configureReconcileAbsent(idempotencyKey: string, absent: boolean) {
      if (absent) reconcileAbsent.add(idempotencyKey);
      else reconcileAbsent.delete(idempotencyKey);
    },
    async place({ idempotencyKey, quote }) {
      placeCalls += 1;
      if (placeMode === "throw") throw new Error("provider_error");
      if (placeMode === "slow") return null;
      if (placeMode === "null") return null;
      if (!orders.has(idempotencyKey)) {
        orders.set(idempotencyKey, { id: crypto.randomUUID() });
      }
      void quote;
      return structuredClone(orders.get(idempotencyKey)!);
    },
    async reconcile({ idempotencyKey, quote }) {
      void quote;
      if (reconcileAbsent.has(idempotencyKey)) {
        return { id: "", status: "absent" as const };
      }
      return structuredClone(orders.get(idempotencyKey) ?? null);
    },
  };
}
