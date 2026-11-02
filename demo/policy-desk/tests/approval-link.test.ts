import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assistantReplyForDisplay,
  safeApprovalHref,
} from "../web/src/approval-link.js";

test("approve-mode link accepts only the same-origin signed approval route", () => {
  const origin = "https://policy-desk.test";
  assert.equal(
    safeApprovalHref("https://policy-desk.test/approve?r=signed", origin),
    "https://policy-desk.test/approve?r=signed",
  );
  assert.equal(
    safeApprovalHref("/approve?r=signed", origin),
    `${origin}/approve?r=signed`,
  );
  assert.equal(
    safeApprovalHref("https://evil.test/approve?r=signed", origin),
    null,
  );
  assert.equal(safeApprovalHref("/review?approval=x", origin), null);
  assert.equal(safeApprovalHref("javascript:alert(1)", origin), null);
  assert.equal(
    safeApprovalHref("https://user:pass@policy-desk.test/approve?r=x", origin),
    null,
  );
  assert.equal(
    safeApprovalHref("https://policy-desk.test/approve", origin),
    null,
  );
});

test("assistant replies replace signed approval URLs with CTA guidance", () => {
  const token = "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6ImFwcl8xMjMifQ.signature";
  const reply = `Refund is waiting: https://policy-desk.test/approve?r=${token}. Use the button above.`;
  const display = assistantReplyForDisplay(reply);

  assert.equal(display.includes(token), false);
  assert.match(display, /Refund is waiting:/);
  assert.match(display, /Review this refund” button above/);
  assert.match(display, /Use the button above\./);
});

test("assistant reply formatting preserves ordinary prose and unrelated links", () => {
  const reply =
    "Order details: https://policy-desk.test/orders/42. [Refund policy](https://example.test/policy).";
  assert.equal(assistantReplyForDisplay(reply), reply);
});

test("assistant replies redact markdown and angle-bracket approval links", () => {
  const token = "a.b.c";
  const reply = `[Open approval](https://policy-desk.test/approve?r=${token}) and <https://policy-desk.test/approve?r=${token}>`;
  const display = assistantReplyForDisplay(reply);
  assert.equal(display.includes(token), false);
  assert.equal(display.match(/Review this refund/g)?.length, 1);
  assert.equal(display.includes("[]()"), false);
});
