import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { serveApp } from "../../../demo/refund-desk/src/server.js";
import { listen } from "../../service/src/server.js";
import { createWorld, type World } from "../helpers/world.js";

let w: World;
let authority: Awaited<ReturnType<typeof listen>>;
let app: ReturnType<typeof serveApp>;
const port = (s: { address(): unknown }) => (s.address() as AddressInfo).port;

before(async () => {
  w = await createWorld();
  authority = await listen(w.handle, 0);
  app = serveApp(async () => new Response(JSON.stringify({ ok: true })), 0);
  await new Promise((r) => app.once("listening", r));
});
after(async () => {
  authority.close();
  app.close();
  await w.close();
});

/** Oversized bodies are refused before they are buffered; the server keeps serving afterwards. */
async function oversized(
  url: string,
  size: number,
  headers: Record<string, string>,
) {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: "x".repeat(size),
    });
    return r.status;
  } catch {
    return "connection_closed"; // acceptable: the server cut the upload short
  }
}

test("Task Authority adapter rejects oversized bodies with 413 and stays healthy", async () => {
  const base = `http://127.0.0.1:${port(authority)}`;
  const token = await w.tok.api();
  const status = await oversized(`${base}/v1/delegations`, 400 * 1024, {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  });
  assert.ok(status === 413 || status === "connection_closed", String(status));
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  // A normal-sized (but invalid) request still reaches the handler.
  const small = await fetch(`${base}/v1/delegations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(small.status, 400);
});

test("customer app adapter rejects oversized bodies with 413 and stays healthy", async () => {
  const base = `http://127.0.0.1:${port(app)}`;
  const status = await oversized(`${base}/mcp`, 600 * 1024, {
    "content-type": "application/json",
  });
  assert.ok(status === 413 || status === "connection_closed", String(status));
  const ok = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
  assert.equal(ok.status, 200);
});
