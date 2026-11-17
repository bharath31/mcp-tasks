/**
 * Miniflare-only worker: exercises real DO SqlStorage via createDoSqlDatabase.
 */
import { DurableObject } from "cloudflare:workers";
import { createDoSqlDatabase, initMerchantSchema } from "../../src/sql.js";

export class MerchantStorageHarness extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const op = new URL(request.url).searchParams.get("op");
    const db = createDoSqlDatabase(this.ctx.storage);
    initMerchantSchema(db);
    if (op === "claim-once") {
      const key = "op-fixed";
      const result = db.transaction(() => {
        const prior = db
          .exec(
            "SELECT operation_id FROM checkout_executions WHERE operation_id = ?",
            key,
          )
          .one();
        if (prior) return { claimed: false as const };
        db.exec(
          `INSERT INTO checkout_executions
           VALUES (?, 'quote-1', 'cust-1', 'processing', ?, NULL)`,
          key,
          key,
        );
        return { claimed: true as const };
      });
      return Response.json(result);
    }
    if (op === "cursor-absent") {
      const row = db
        .exec(
          "SELECT operation_id FROM checkout_executions WHERE operation_id = ?",
          "missing",
        )
        .one();
      return Response.json({ row });
    }
    return new Response("unknown", { status: 400 });
  }
}

export default {
  async fetch(request: Request, env: { HARNESS: DurableObjectNamespace }) {
    const id = env.HARNESS.idFromName("harness");
    return env.HARNESS.get(id).fetch(request);
  },
};