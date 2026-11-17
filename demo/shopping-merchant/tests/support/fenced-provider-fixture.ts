/**
 * Test bundle only: SQLite-coordinated order provider + atomicAbandonAbsent for commerce-parity abandonment tests.
 * Never wire from production port-env or deployable Worker code.
 */
import type { DatabaseSync } from "node:sqlite";
import type {
  AtomicAbandonAbsent,
  MerchantLedgerPorts,
  OrderProviderPort,
  Quote,
} from "../../src/types.js";
import {
  createFixtureApprovalVerifier,
  createFixtureCustomerAccount,
} from "./fixtures.js";

const FENCED_ORDERS_DDL = `CREATE TABLE IF NOT EXISTS fixture_provider_fenced_orders (
  provider_key TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  quote TEXT NOT NULL
)`;

function installFencedProviderTable(db: DatabaseSync): void {
  db.exec(FENCED_ORDERS_DDL);
}

function locked<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export type FencedFixturePorts = MerchantLedgerPorts & {
  getPlaceCalls(): number;
  approveForTest(quote: Quote): void;
  configurePlace(mode: "success" | "null"): void;
};

/** Ledger + provider share one SQLite file so abandon can fence placement atomically. */
export function createFencedFixturePorts(
  rawDb: DatabaseSync,
): FencedFixturePorts {
  installFencedProviderTable(rawDb);
  const approval = createFixtureApprovalVerifier();
  let placeCalls = 0;
  let placeMode: "success" | "null" = "success";

  const orderProvider: OrderProviderPort = {
    async place({ quote, idempotencyKey }) {
      if (placeMode === "null") return null;
      return locked(rawDb, () => {
        placeCalls += 1;
        const execution = rawDb
          .prepare("SELECT * FROM checkout_executions WHERE operation_id = ?")
          .get(idempotencyKey) as
          | {
              status: string;
              quote_id: string;
              provider_key: string;
            }
          | undefined;
        const snapshot = rawDb
          .prepare("SELECT data FROM quotes WHERE id = ?")
          .get(quote.id) as { data: string } | undefined;
        if (
          !execution ||
          execution.status !== "processing" ||
          execution.quote_id !== quote.id ||
          execution.provider_key !== idempotencyKey ||
          !snapshot ||
          snapshot.data !== JSON.stringify(quote) ||
          Date.now() >= Date.parse(quote.expiresAt)
        ) {
          return null;
        }
        rawDb
          .prepare(
            "INSERT OR IGNORE INTO fixture_provider_fenced_orders VALUES (?, ?, ?)",
          )
          .run(idempotencyKey, crypto.randomUUID(), JSON.stringify(quote));
        const saved = rawDb
          .prepare(
            "SELECT id FROM fixture_provider_fenced_orders WHERE provider_key = ?",
          )
          .get(idempotencyKey) as { id: string } | undefined;
        return saved ? { id: saved.id } : null;
      });
    },
    async reconcile({ idempotencyKey, quote }) {
      void quote;
      const found = rawDb
        .prepare(
          "SELECT id FROM fixture_provider_fenced_orders WHERE provider_key = ?",
        )
        .get(idempotencyKey) as { id: string } | undefined;
      if (!found) return { id: "", status: "absent" as const };
      return { id: found.id };
    },
  };

  const atomicAbandonAbsent: AtomicAbandonAbsent = async ({
    quote,
    idempotencyKey,
  }) => {
    locked(rawDb, () => {
      const execution = rawDb
        .prepare("SELECT * FROM checkout_executions WHERE operation_id = ?")
        .get(idempotencyKey) as
        | {
            status: string;
            quote_id: string;
            customer_id: string;
            provider_key: string;
          }
        | undefined;
      if (
        !execution ||
        execution.status !== "processing" ||
        execution.quote_id !== quote.id ||
        execution.customer_id !== quote.customerId ||
        execution.provider_key !== idempotencyKey
      ) {
        return;
      }
      if (
        rawDb
          .prepare(
            "SELECT 1 AS ok FROM fixture_provider_fenced_orders WHERE provider_key = ?",
          )
          .get(idempotencyKey)
      ) {
        return;
      }
      rawDb
        .prepare(
          "UPDATE checkout_executions SET status = 'abandoned' WHERE operation_id = ? AND status = 'processing'",
        )
        .run(idempotencyKey);
    });
  };

  return {
    customerAccount: createFixtureCustomerAccount(),
    verifyCustomerApproval: approval,
    orderProvider,
    atomicAbandonAbsent,
    getPlaceCalls() {
      return placeCalls;
    },
    approveForTest(quote: Quote) {
      approval.approveForTest(quote);
    },
    configurePlace(mode: "success" | "null") {
      placeMode = mode;
    },
  };
}
