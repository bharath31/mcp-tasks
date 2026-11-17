import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mainSrc = readFileSync(
  fileURLToPath(new URL("../src/main.ts", import.meta.url)),
  "utf8",
);

test("main wires add-to-cart through session or agent-browser cart API", () => {
  assert.match(mainSrc, /shoppingApi\.addCartItem/);
  assert.match(mainSrc, /shoppingApi\.agentBrowserAddCartItem/);
  assert.match(mainSrc, /ui\.agentBrowserCart/);
  assert.match(mainSrc, /addToCart\(p\.id\)/);
});

test("main cancels stale polls on bootstrap refresh", () => {
  assert.match(mainSrc, /function cancelPolls/);
  assert.match(mainSrc, /cancelPolls\(\)/);
  assert.match(mainSrc, /generation !== pollGeneration/);
});

test("main clears aria-busy after render", () => {
  assert.match(mainSrc, /setAttribute\("aria-busy", "false"\)/);
});

test("Guardian review links use noopener noreferrer", () => {
  assert.match(mainSrc, /rel: "noopener noreferrer"/);
  assert.match(mainSrc, /safeNavHref\(\s*ui\.approval\.reviewUrl/s);
});

test("auth links validate URLs before href", () => {
  assert.match(mainSrc, /safeNavHref\(ui\.session\?\.loginUrl/);
  assert.match(mainSrc, /shoppingApi\.signOut/);
  assert.match(mainSrc, /data-nominee-action": "logout"/);
});
