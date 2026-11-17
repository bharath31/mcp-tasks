import assert from "node:assert/strict";
import test from "node:test";
import { safeNavHref } from "../src/nav.js";

const ORIGIN = "https://shop.example.test";

test("safeNavHref allows same-origin relative paths", () => {
  assert.equal(safeNavHref("/login", ORIGIN), "/login");
  assert.equal(safeNavHref("/auth/logout?return=/", ORIGIN), "/auth/logout?return=/");
});

test("safeNavHref allows same-origin absolute https URLs as relative paths", () => {
  assert.equal(
    safeNavHref("https://shop.example.test/guardian/review/abc", ORIGIN),
    "/guardian/review/abc",
  );
});

test("safeNavHref rejects javascript, data, and off-origin URLs", () => {
  assert.equal(safeNavHref("javascript:alert(1)", ORIGIN), null);
  assert.equal(safeNavHref("data:text/html,hello", ORIGIN), null);
  assert.equal(safeNavHref("https://evil.example/phish", ORIGIN), null);
  assert.equal(safeNavHref("//evil.example/path", ORIGIN), null);
  assert.equal(safeNavHref("", ORIGIN), null);
  assert.equal(safeNavHref(null, ORIGIN), null);
});