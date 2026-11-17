import {
  createAgentCapabilityPorts,
  executeShoppingAgentRun,
  getShoppingAgentRun,
  prepareShoppingAgentRun,
  type RunPortsFactory,
  type ShoppingAgentOrchestrationEnv,
} from "../../../shopping-agent-orchestration/src/index.js";
import { shoppingRequest } from "../../../shopping-agent/src/index.js";
import type { CustomerAccessTokenDeps } from "../../../shopping-merchant/src/identity/customer-access-token.js";
import {
  AGENT_CAPABILITY_COOKIE,
  AGENT_CAPABILITY_TTL_MS,
  clearAgentCapabilityCookie,
  encodeAgentCapabilityCookie,
  hashAgentCapabilitySecret,
  mintAgentCapabilitySecret,
} from "./agent-capability.js";
import { customerStateRpc, customerStateStub } from "./customer-state-do.js";
import type { ShoppingLiveEnv } from "./env.js";
import { json, problem, serviceUnavailable } from "./http.js";
import type { AuthenticatedCustomer } from "./session.js";

export type AgentHostDeps = CustomerAccessTokenDeps & {
  agentPorts?: RunPortsFactory;
};

export function agentIntegrationConfigured(
  env: ShoppingLiveEnv,
): env is ShoppingLiveEnv & ShoppingAgentOrchestrationEnv {
  return Boolean(
    env.AGENT_RUNS &&
    env.AI &&
    env.BROWSER &&
    env.MERCHANT_ORIGIN?.startsWith("http"),
  );
}

function orchestrationEnv(
  env: ShoppingLiveEnv & ShoppingAgentOrchestrationEnv,
): ShoppingAgentOrchestrationEnv {
  return {
    AGENT_RUNS: env.AGENT_RUNS,
    AI: env.AI,
    BROWSER: env.BROWSER,
    MERCHANT_ORIGIN: env.MERCHANT_ORIGIN,
    AGENT_MODEL: env.AGENT_MODEL,
  };
}

async function storeAndRevokePriorCapabilities(
  env: ShoppingLiveEnv,
  customer: AuthenticatedCustomer,
  runId: string,
  digest: string,
  expiresAtMs: number,
): Promise<void> {
  const stub = customerStateStub(env, customer.customerId);
  await customerStateRpc(stub, customer.customerId, {
    op: "revokeAgentCapabilitiesExcept",
    keepRunId: runId,
  });
  await customerStateRpc(stub, customer.customerId, {
    op: "putAgentCapability",
    runId,
    innerSid: customer.innerSid,
    digest,
    expiresAtMs,
  });
}

async function revokeRunCapability(
  env: ShoppingLiveEnv,
  customerId: string,
  runId: string,
): Promise<void> {
  const stub = customerStateStub(env, customerId);
  await customerStateRpc(stub, customerId, {
    op: "revokeAgentCapability",
    runId,
  });
}

export async function handleAgentStart(
  req: Request,
  env: ShoppingLiveEnv,
  customer: AuthenticatedCustomer,
  ctx: ExecutionContext,
  deps: AgentHostDeps = {},
): Promise<Response> {
  if (!agentIntegrationConfigured(env)) {
    return serviceUnavailable(
      "agent_unavailable",
      "Agent runs require Workers AI, Browser Run, and agent run storage bindings.",
    );
  }
  const body = (await req.json().catch(() => null)) as {
    goal?: unknown;
  } | null;
  const goal = typeof body?.goal === "string" ? body.goal.trim() : "";
  try {
    shoppingRequest.parse({ goal });
  } catch {
    return problem(400, "invalid_goal", "goal must be a short string.");
  }

  const orchEnv = orchestrationEnv(env);
  const ownerId = customer.customerId;
  const prepared = await prepareShoppingAgentRun(orchEnv, { ownerId, goal });

  const capSecret = mintAgentCapabilitySecret();
  const expiresAtMs = Date.now() + AGENT_CAPABILITY_TTL_MS;
  const digest = await hashAgentCapabilitySecret(
    customer.customerId,
    prepared.credential.runId,
    capSecret,
  );
  await storeAndRevokePriorCapabilities(
    env,
    customer,
    prepared.credential.runId,
    digest,
    expiresAtMs,
  );

  const signedCap = await encodeAgentCapabilityCookie(env, {
    customerId: customer.customerId,
    runId: prepared.credential.runId,
    secret: capSecret,
  });
  const capabilityCookie = {
    name: AGENT_CAPABILITY_COOKIE,
    value: signedCap,
    domain: new URL(env.MERCHANT_ORIGIN).hostname,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Strict" as const,
  };

  const ports: RunPortsFactory =
    deps.agentPorts ?? createAgentCapabilityPorts([capabilityCookie]);

  const runExecution = async (): Promise<void> => {
    try {
      await executeShoppingAgentRun({
        env: orchEnv,
        ownerId,
        credential: prepared.credential,
        goal,
        ports,
      });
    } finally {
      await revokeRunCapability(
        env,
        customer.customerId,
        prepared.credential.runId,
      );
    }
  };
  if (env.SHOPPING_AGENT_AWAIT_RUN === "1") {
    await runExecution();
  } else {
    ctx.waitUntil(runExecution());
  }

  const run = await getShoppingAgentRun(
    orchEnv,
    ownerId,
    prepared.credential.runId,
  );
  if (!run) {
    return serviceUnavailable(
      "agent_start_failed",
      "Agent run could not be created.",
    );
  }

  return json(run);
}

export async function handleAgentPoll(
  env: ShoppingLiveEnv,
  customer: AuthenticatedCustomer,
  runId: string,
): Promise<Response> {
  if (!agentIntegrationConfigured(env)) {
    return serviceUnavailable(
      "agent_unavailable",
      "Agent runs are not connected.",
    );
  }
  const run = await getShoppingAgentRun(
    orchestrationEnv(env),
    customer.customerId,
    runId,
  );
  if (!run || run.ownerId !== customer.customerId) {
    return problem(404, "run_not_found", "Agent run not found.");
  }
  return json(run);
}
