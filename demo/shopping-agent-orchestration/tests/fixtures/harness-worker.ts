/**
 * Miniflare harness entry: owner-bound ShoppingAgentRunState DO.
 */
import { ShoppingAgentRunState } from "../../src/agent-run-do.js";

export { ShoppingAgentRunState };

export default {
  async fetch(
    request: Request,
    env: { AGENT_RUNS: DurableObjectNamespace },
  ): Promise<Response> {
    const ownerId = request.headers.get("x-nominee-owner-id");
    if (!ownerId) {
      return Response.json(
        { ok: false, error: "owner_required" },
        { status: 400 },
      );
    }
    const stub = env.AGENT_RUNS.get(env.AGENT_RUNS.idFromName(ownerId));
    return stub.fetch(request);
  },
};
