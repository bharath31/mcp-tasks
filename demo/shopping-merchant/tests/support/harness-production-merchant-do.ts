/**
 * Miniflare production-path harness only — extends deployable DO with harness RPC ops
 * that live exclusively in tests/support (never bundled into merchant Worker deploy).
 */
import { CustomerMerchantLedger } from "../../src/merchant-do.js";
import {
  MERCHANT_HOST_INTERNAL_SECRET_HEADER,
  readHostInternalSecret,
} from "../../src/port-env.js";
import type { HumanActor } from "../../src/types.js";
import {
  harnessOpenMerchantDatabase,
  harnessSetCibaChallengeApprovedUnbridged,
  harnessSetQuoteExpiresAt,
  isHarnessLedgerMutationOp,
  type HarnessLedgerMutationBody,
} from "./harness-ledger-mutations.js";

export class HarnessProductionCustomerMerchantLedger extends CustomerMerchantLedger {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return super.fetch(request);
    }
    const customerId = request.headers.get("x-nominee-customer-id");
    if (!customerId) {
      return super.fetch(request);
    }
    let body: HarnessLedgerMutationBody | { op?: string };
    try {
      body = (await request.clone().json()) as HarnessLedgerMutationBody;
    } catch {
      return super.fetch(request);
    }
    if (!isHarnessLedgerMutationOp(body.op)) {
      return super.fetch(request);
    }
    const mutation = body as HarnessLedgerMutationBody;

    if (!readHostInternalSecret(this.env)) {
      return Response.json(
        {
          error: "merchant_host_unavailable",
          detail:
            "MERCHANT_HOST_INTERNAL_SECRET is not configured; DO ledger RPC stays disabled (fail-closed).",
        },
        { status: 503 },
      );
    }
    const configured = readHostInternalSecret(this.env);
    const presented = request.headers.get(MERCHANT_HOST_INTERNAL_SECRET_HEADER);
    if (
      !configured ||
      presented === null ||
      presented.length === 0 ||
      presented !== configured
    ) {
      return Response.json(
        { error: "host_internal_forbidden" },
        { status: 403 },
      );
    }

    const db = harnessOpenMerchantDatabase(this.ctx.storage);

    if (mutation.op === "harnessSetQuoteExpiresAt") {
      try {
        const quote = harnessSetQuoteExpiresAt(
          db,
          customerId,
          mutation.quoteId,
          mutation.expiresAt,
        );
        return Response.json(quote);
      } catch (error) {
        const message = error instanceof Error ? error.message : "error";
        const status =
          message === "not_found_or_forbidden"
            ? 403
            : message === "merchant_ports_unconfigured"
              ? 503
              : 409;
        return Response.json({ error: message }, { status });
      }
    }

    const human = mutation.actor as HumanActor;
    if (
      !human ||
      human.kind !== "human" ||
      human.customerId !== customerId ||
      !Array.isArray(human.scopes)
    ) {
      return Response.json(
        { error: "not_found_or_forbidden" },
        { status: 403 },
      );
    }
    const result = await harnessSetCibaChallengeApprovedUnbridged(
      db,
      customerId,
      mutation.challengeId,
    );
    if ("ok" in result && result.ok) {
      return Response.json({ ok: true });
    }
    const failed = result as { error: string; status: number };
    return Response.json({ error: failed.error }, { status: failed.status });
  }
}
