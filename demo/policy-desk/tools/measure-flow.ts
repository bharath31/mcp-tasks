// Counts the network round trips behind each request of the reviewer's whole flow, the way
// the browser makes them: sign in, create the sandbox, ask the agent for a $150 refund,
// open Reviews, claim, approve, and have the agent finish. Postgres and FGA round trips are
// what the deployed Worker pays for on every request (each one crosses the network), so a
// count here is a latency budget. Uses the test world (local Postgres, local OIDC stand-in).
//
//   TEST_PG_ADMIN_URL=postgres://... node --import tsx demo/policy-desk/tools/measure-flow.ts
import pg from "pg";
import { startWorld } from "../tests/helpers/world.js";

type Tally = {
  db: number;
  fga: number;
  idp: number;
  model: number;
  ms: number;
};
let cur: Tally | null = null;

const query = pg.Client.prototype.query;
pg.Client.prototype.query = function (this: pg.Client, ...a: any[]) {
  if (cur) {
    const sql = typeof a[0] === "string" ? a[0] : a[0]?.text;
    if (/fga_tuples/.test(String(sql))) cur.fga++;
    else cur.db++;
  }
  return (query as any).apply(this, a);
} as any;
const connect = pg.Client.prototype.connect;
pg.Client.prototype.connect = function (this: pg.Client, ...a: any[]) {
  if (cur) cur.db += 3; // TCP + TLS + startup/auth: about three round trips before the first query
  return (connect as any).apply(this, a);
} as any;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  if (cur) cur.idp++;
  return realFetch(input, init);
}) as typeof fetch;

const w = await startWorld();
const rows: Array<[string, Tally]> = [];
async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t: Tally = { db: 0, fga: 0, idp: 0, model: 0, ms: 0 };
  const prev = cur;
  cur = t;
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    t.ms = performance.now() - t0;
    cur = prev;
    rows.push([label, t]);
  }
}

let modelCalls = 0;
const say = (content: string) => ({ choices: [{ message: { content } }] });
const tool = (name: string, args: unknown) => ({
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          {
            id: `c${modelCalls}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
    },
  ],
});
let script: Array<(m: any[]) => any> = [];
w.env.AI = {
  async run(_m: string, input: any) {
    if (cur) cur.model++;
    modelCalls++;
    return script.shift()!(input.messages);
  },
};
const lastTool = (m: any[]) =>
  JSON.parse(m.filter((x) => x.role === "tool").at(-1).content);

try {
  const alice = await w.login("alice");
  const get = (p: string, tok = alice) =>
    step(`GET ${p.split("?")[0]}`, () => w.call("GET", p, tok));

  await step("POST /sandbox/reset (create sandbox)", () =>
    w.call("POST", "/sandbox/reset", alice, {}),
  );
  await Promise.all([get("/sandbox/me"), get("/sandbox/info")]);
  await get("/sandbox/state");
  await get("/sandbox/progress");

  script = [
    () => tool("list_orders", {}),
    (m) => {
      const o = lastTool(m).orders.find((x: any) => x.amountMinor >= 15000);
      return tool("request_refund", {
        orderId: o.orderId,
        amountMinor: 15000,
        reason: "Wrong size",
      });
    },
    (m) => say(`Status: ${lastTool(m).status}`),
  ];
  const turn = await step("POST /sandbox/agent (ask for $150)", () =>
    w.call("POST", "/sandbox/agent", alice, {
      messages: [{ role: "user", content: "Refund $150" }],
    }),
  );
  const task = turn.json.trace.find((s: any) => s.task)?.task;
  await get("/sandbox/state");

  const rev = await w.reviewer("alice");
  const qp = "/v1/approval-requests";
  const q = await step(`GET ${qp}`, async () => {
    const r = await w.raw(`${qp}?status=pending`, {
      token: rev.token,
      dpop: await rev.prove("GET", qp),
    });
    return (await r.json()) as any;
  });
  const approval = q.approvals[0];
  await step("POST /v1/approval-requests/:id/lease", () =>
    rev.post(`/v1/approval-requests/${approval.id}/lease`, {}),
  );
  await step("POST /v1/approval-requests/:id/decisions", () =>
    rev.post(`/v1/approval-requests/${approval.id}/decisions`, {
      decision: "approve",
      operationDigest: approval.operationDigest,
    }),
  );

  script = [
    () => tool("get_task", { taskId: task.taskId }),
    (m) => say(`Status: ${lastTool(m).status}`),
  ];
  const done = await step("POST /sandbox/agent (check on it)", () =>
    w.call("POST", "/sandbox/agent", alice, {
      messages: [{ role: "user", content: "Check on it" }],
    }),
  );
  if (!/completed/.test(done.json.reply))
    throw new Error(`flow did not complete: ${done.json.reply}`);
} finally {
  cur = null;
  await w.close();
}

// Postgres round trip from the Worker: far from the database (an edge in another region)
// versus placed next to it (wrangler.jsonc placement). FGA and Auth0 are elsewhere either way.
const FAR = Number(process.env.FAR_RTT_MS ?? 150);
const NEAR = Number(process.env.NEAR_RTT_MS ?? 2);
const FGA = 120;
const IDP = 150;
const est = (t: Tally, db: number) => t.db * db + t.fga * FGA + t.idp * IDP;
console.log(
  `\nRound trips per request. Estimates: ${FAR} ms (far) or ${NEAR} ms (placed) per Postgres round trip, ${FGA} ms per FGA call, ${IDP} ms per Auth0 call; model time excluded.\n`,
);
console.log(
  "request".padEnd(46),
  "pg".padStart(4),
  "fga".padStart(4),
  "idp".padStart(4),
  "llm".padStart(4),
  "far ms".padStart(8),
  "placed".padStart(8),
);
let far = 0;
let near = 0;
for (const [label, t] of rows) {
  far += est(t, FAR);
  near += est(t, NEAR);
  console.log(
    label.padEnd(46),
    String(t.db).padStart(4),
    String(t.fga).padStart(4),
    String(t.idp).padStart(4),
    String(t.model).padStart(4),
    String(Math.round(est(t, FAR))).padStart(8),
    String(Math.round(est(t, NEAR))).padStart(8),
  );
}
console.log(
  `${"total".padEnd(66)}${String(Math.round(far)).padStart(8)} ${String(Math.round(near)).padStart(8)}`,
);
