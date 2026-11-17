import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("api module does not persist secrets in browser storage", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/api.ts", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(src, /\blocalStorage\b/);
  assert.doesNotMatch(src, /\bsessionStorage\b/);
});

test("api routes match the live shopping contract", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/api.ts", import.meta.url)),
    "utf8",
  );
  const routes = [
    '"/session"',
    '"/agent/start"',
    '"/agent-browser/session"',
    '"/agent-browser/cart"',
    '"/agent-browser/cart/items"',
    "`/agent/${",
    '"/cart"',
    '"/cart/items"',
    '"/quote"',
    '"/approval/start"',
    "`/approval/${",
    '"/order/execute"',
  ];
  for (const route of routes)
    assert.match(src, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
