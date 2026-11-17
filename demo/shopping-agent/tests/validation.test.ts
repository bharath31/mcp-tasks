import assert from "node:assert/strict";
import test from "node:test";
import {
  actionFromToolCall,
  hostAction,
  PERMITTED_TOOL_NAMES,
} from "../src/actions.js";
import { shoppingAgentConfig } from "../src/config.js";
import {
  assertTrustedAbsoluteUrl,
  shouldAllowBrowserRequest,
} from "../src/guard.js";
import { redactText } from "../src/redact.js";
import { expectedProductDisplayName } from "../src/selectors.js";

const baseConfig = shoppingAgentConfig.parse({
  merchantOrigin: "https://shop.example.test",
});

test("rejects model tool names outside the host surface", () => {
  assert.throws(() => actionFromToolCall("eval", "{}"), /not permitted/);
  assert.throws(() =>
    actionFromToolCall("navigate_shop", '{"path":"https://evil.test"}'),
  );
});

test("add_to_cart only accepts catalog product ids", () => {
  const action = actionFromToolCall("add_to_cart", '{"productId":"tray"}');
  hostAction.parse(action);
  assert.throws(() => actionFromToolCall("add_to_cart", '{"productId":"mug"}'));
});

test("navigation stays on configured HTTPS origin", () => {
  assert.throws(() =>
    assertTrustedAbsoluteUrl(baseConfig, "http://shop.example.test/"),
  );
  assert.throws(() =>
    assertTrustedAbsoluteUrl(baseConfig, "https://evil.test/"),
  );
  assert.doesNotThrow(() =>
    assertTrustedAbsoluteUrl(baseConfig, "https://shop.example.test/"),
  );
});

test("defense-in-depth request filter blocks foreign HTTPS hosts", () => {
  assert.equal(
    shouldAllowBrowserRequest(baseConfig, "https://shop.example.test/a.svg"),
    true,
  );
  assert.equal(
    shouldAllowBrowserRequest(baseConfig, "https://cdn.other.test/a.svg"),
    false,
  );
});

test("product display names are host-owned and not derived from model input", () => {
  assert.equal(expectedProductDisplayName("tray"), "Catchall tray");
  assert.doesNotThrow(() => PERMITTED_TOOL_NAMES.has("add_to_cart"));
});

test("redacts bearer tokens and live view hints", () => {
  const out = redactText("see cf-brapi-live-view-token abc and Bearer secret123");
  assert.match(out, /\[redacted\]/);
  assert.doesNotMatch(out, /secret123/);
});