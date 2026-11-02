import {
  ACTION_POLICIES,
  AGENTS,
  BASE_TUPLES,
  CLIENTS,
  ORG,
  PEOPLE,
  PERMISSIONS,
  TENANT_ID,
} from "@task-authority/test-fixtures";
import {
  DEMO_DEFAULTS,
  DEMO_QUOTAS,
  type ServiceConfig,
  type TenantConfig,
} from "../../service/src/config.js";
import { createHandler } from "../../service/src/http.js";
import { Store } from "../../service/src/store.js";
import { Clock, LiveClock } from "./clock.js";
import { HookedFga, makeFga, MemoryFga } from "./fga.js";
import { TestIdp, type MintOptions } from "./idp.js";
import type { OidcServer } from "./oidc-server.js";
import { createTestDb } from "./pg.js";

export const BASE_URL = "http://authority.test";
export { AGENTS, CLIENTS, ORG, PEOPLE, TENANT_ID };

export type CallOptions = {
  token?: string;
  subject?: string;
  body?: unknown;
  idem?: string;
  headers?: Record<string, string>;
};

let seq = 0;
export async function createWorld(
  opts: {
    quotas?: Partial<TenantConfig["quotas"]>;
    secondTenant?: boolean;
    liveClock?: boolean;
    /** Use a local OIDC provider's issuer and signing key instead of the default test issuer. */
    oidc?: OidcServer;
  } = {},
) {
  const clock = opts.liveClock ? new LiveClock() : new Clock();
  const idp = opts.oidc
    ? await TestIdp.restore(
        opts.oidc.privateJwk,
        opts.oidc.jwk,
        clock,
        opts.oidc.issuer,
      )
    : await TestIdp.create(clock);
  const fga = new HookedFga(await makeFga());
  await fga.write(BASE_TUPLES);
  const db = await createTestDb();
  const store = new Store(db.url, 12);
  await store.migrate();

  const tenant: TenantConfig = {
    tenantId: TENANT_ID,
    issuer: idp.issuer,
    audience: idp.audience,
    keys: idp.keys,
    fga,
    actions: ACTION_POLICIES,
    defaults: { ...DEMO_DEFAULTS },
    quotas: { ...DEMO_QUOTAS, ...opts.quotas },
  };
  const tenants = [tenant];
  let idp2: TestIdp | undefined;
  if (opts.secondTenant) {
    idp2 = await TestIdp.create(
      clock,
      "https://other-tenant.example/",
      "https://task-authority.example/api",
    );
    tenants.push({
      ...tenant,
      tenantId: "tnt_other",
      issuer: idp2.issuer,
      keys: idp2.keys,
      fga: new MemoryFga(),
    });
  }
  // Explicit fixture policies: the service itself never synthesizes an allow policy.
  for (const t of tenants)
    for (const organizationId of Object.values(ORG)) {
      const resourceServer = `merchant:${organizationId}/refunds`;
      const document = {
        resource_server: resourceServer,
        version: "fixture-policy-v1",
        unknown_action: "deny",
        actions: Object.fromEntries(
          Object.entries(ACTION_POLICIES).map(([name, a]) => [
            name,
            {
              arguments: {},
              approvers: { relation: a.approverRelation, on: "organization" },
              requester_relation: a.requesterRelation,
              rules: [],
              default: { allow: {} },
            },
          ]),
        ),
        tiers: {
          routine: {
            assurance: "per_operation",
            max_age: 300,
            factors: ["webauthn-platform", "webauthn-roaming", "otp"],
          },
        },
      };
      await store.pool.query(
        "insert into authority.policy_versions(tenant_id,resource_server,version,document,created_by,created_at) values($1,$2,$3,$4,'fixture',$5)",
        [
          t.tenantId,
          resourceServer,
          document.version,
          JSON.stringify(document),
          new Date(clock.now()).toISOString(),
        ],
      );
      await store.pool.query(
        "insert into authority.policy_state(tenant_id,resource_server,active_version) values($1,$2,$3)",
        [t.tenantId, resourceServer, document.version],
      );
    }
  const config: ServiceConfig = {
    tenants,
    allowedOrigins: ["https://app.example"],
    clockSkewSec: 5,
  };
  const logs: Array<Record<string, unknown>> = [];
  const handle = createHandler({
    store,
    config,
    now: clock.now,
    log: (e) => logs.push(e),
  });

  const call = async (
    method: "GET" | "POST" | "PUT",
    path: string,
    o: CallOptions = {},
  ) => {
    const headers: Record<string, string> = { ...o.headers };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.subject) headers["x-task-authority-subject"] = o.subject;
    if (o.idem) headers["idempotency-key"] = o.idem;
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const res = await handle(
      new Request(`${BASE_URL}${path}`, {
        method,
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
      }),
    );
    const text = await res.text();
    return {
      status: res.status,
      json: (text ? JSON.parse(text) : undefined) as any,
      headers: res.headers,
    };
  };

  const tok = {
    api: () => idp.service(CLIENTS.api, PERMISSIONS.api),
    executor: () => idp.service(CLIENTS.executor, PERMISSIONS.executor),
    investigator: () =>
      idp.service(CLIENTS.investigator, PERMISSIONS.investigator),
    rogue: () =>
      idp.service(CLIENTS.rogue, [...PERMISSIONS.api, ...PERMISSIONS.executor]),
    user: (sub: string, orgId: string, extra: Partial<MintOptions> = {}) =>
      idp.mint({ sub, orgId, ...extra }),
  };

  const w = {
    clock,
    idp,
    idp2,
    fga,
    store,
    config,
    tenant,
    call,
    tok,
    logs,
    handle,
    async close() {
      await store.close();
      await fga.close();
      await db.drop();
    },
    iso: (offsetMs = 0) => new Date(clock.now() + offsetMs).toISOString(),

    /** Creates a delegation as the backend, forwarding the grantor's verified token. */
    async delegate(
      o: {
        ownerType?: "user" | "organization";
        person?: string;
        org?: string;
        agent?: string;
        actions?: string[];
        ttlMs?: number;
        ceilings?: Record<string, number>;
        resourcePrefixes?: string[];
        idem?: string;
      } = {},
    ) {
      const person = o.person ?? PEOPLE.alice;
      const orgId = o.org ?? ORG.northstar;
      return call("POST", "/v1/delegations", {
        token: await tok.api(),
        subject: await tok.user(person, orgId),
        idem: o.idem,
        body: {
          ownerType: o.ownerType ?? "user",
          organizationId: orgId,
          agentId: o.agent ?? AGENTS.returns,
          resource: `merchant:${orgId}/refunds`,
          actions: o.actions ?? ["refund:create"],
          expiresAt: w.iso(o.ttlMs ?? 48 * 3600_000),
          ...(o.ceilings ? { ceilings: o.ceilings } : {}),
          ...(o.resourcePrefixes
            ? { resourcePrefixes: o.resourcePrefixes }
            : {}),
        },
      });
    },
    async register(
      delegationId: string,
      o: {
        key?: string;
        amountMinor?: number;
        assertion?: "none" | "human";
        initiator?: string | null;
        initiatorOrg?: string;
        version?: string;
        action?: string;
        resource?: string;
        args?: Record<string, unknown>;
        taskId?: string;
        idem?: string;
      } = {},
    ) {
      return call("POST", "/v1/operations", {
        token: await tok.api(),
        subject:
          o.initiator === null
            ? undefined
            : await tok.user(
                o.initiator ?? PEOPLE.alice,
                o.initiatorOrg ?? ORG.northstar,
              ),
        idem: o.idem,
        body: {
          delegationId,
          operationKey:
            o.key ?? `northstar:refund:payment-742:attempt-${++seq}`,
          taskId: o.taskId ?? "task-1",
          action: o.action ?? "refund:create",
          resource: o.resource ?? "payment:742",
          arguments: o.args ?? {
            merchant: ORG.northstar,
            orderId: "742",
            paymentId: "pi_test_742",
            amountMinor: o.amountMinor ?? 15000,
            currency: "USD",
            destination: "original_payment_method",
          },
          approvalAssertion: o.assertion ?? "human",
          ...(o.version ? { businessStateVersion: o.version } : {}),
        },
      });
    },
    async requestApproval(opId: string) {
      return call("POST", `/v1/operations/${opId}/approval-requests`, {
        token: await tok.api(),
        body: { permission: "refund_approve" },
      });
    },
    async approve(
      approvalId: string,
      digest: string,
      o: {
        person?: string;
        org?: string;
        decision?: "approve" | "reject";
        mfa?: boolean;
        authTime?: number | null;
        details?: Array<Record<string, unknown>> | null;
        jti?: string;
        digestOverride?: string;
      } = {},
    ) {
      const details =
        o.details === null
          ? undefined
          : (o.details ?? [
              {
                type: "task_authority_approval",
                approval_id: approvalId,
                operation_digest: digest,
              },
            ]);
      const token = await tok.user(
        o.person ?? PEOPLE.morgan,
        o.org ?? ORG.northstar,
        {
          mfa: o.mfa ?? true,
          authTime: o.authTime,
          details,
          jti: o.jti,
        },
      );
      return call("POST", `/v1/approval-requests/${approvalId}/decisions`, {
        token,
        body: {
          decision: o.decision ?? "approve",
          operationDigest: o.digestOverride ?? digest,
        },
      });
    },
    async claim(
      op: { id: string; digest: string; operationKey: string },
      o: {
        key?: string;
        digest?: string;
        token?: string;
        version?: string;
        idem?: string;
      } = {},
    ) {
      return call("POST", `/v1/operations/${op.id}/claims`, {
        token: o.token ?? (await tok.executor()),
        idem: o.idem,
        body: {
          operationDigest: o.digest ?? op.digest,
          executionKey: o.key ?? op.operationKey,
          ...(o.version ? { businessStateVersion: o.version } : {}),
        },
      });
    },
    async outcome(
      opId: string,
      claimId: string,
      providerStatus: string,
      ref?: string,
    ) {
      return call("POST", `/v1/operations/${opId}/outcomes`, {
        token: await tok.executor(),
        body: {
          claimId,
          providerStatus,
          ...(ref ? { providerReference: ref } : {}),
        },
      });
    },
    async audit(opId: string) {
      const r = await call("GET", `/v1/operations/${opId}/audit`, {
        token: await tok.investigator(),
      });
      return r.json.events as Array<{
        type: string;
        decision: string;
        reasonCode: string | null;
        correlationId: string;
        actor: { id: string };
        claimId: string | null;
      }>;
    },
    /** Delegation + registered $150 exception operation + requested approval. */
    async exception(
      o: {
        ownerType?: "user" | "organization";
        delegator?: string;
        amountMinor?: number;
      } = {},
    ) {
      const d = await w.delegate({
        ownerType: o.ownerType ?? "user",
        person: o.delegator,
      });
      const op = await w.register(d.json.id, {
        amountMinor: o.amountMinor ?? 15000,
      });
      const ap = await w.requestApproval(op.json.id);
      return { d: d.json, op: op.json, ap: ap.json };
    },
  };
  return w;
}
export type World = Awaited<ReturnType<typeof createWorld>>;
