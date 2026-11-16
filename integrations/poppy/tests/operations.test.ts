import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseExtensions,
  operationsNegotiated,
  parseApprovalHeader,
  parseMcpApproval,
  createOperation,
  approvalRequired,
  approvalDeclined,
  mcpApprovalRequired,
  mcpApprovalDeclined,
  merchantReviewAlternative,
  buildDiscovery,
  validateDiscovery,
} from "../src/index.js";
const wire =
  'operation_id="order_1", revision="rev_1", approver="user", approved_at=1791487260, input_type="tap"';
const operation = createOperation({
  operation_id: "order_1",
  revision: "rev_1",
  terms: { amount: 42 },
  expires_at: "2026-10-08T19:20:00Z",
});
test("negotiates only exact version, ignores malformed extensions and rejects duplicates", () => {
  assert.equal(
    operationsNegotiated("1.0", '"operations";v="3", "links";v="1"'),
    true,
  );
  assert.equal(operationsNegotiated("1.0", '"operations";v="2"'), false);
  assert.equal(operationsNegotiated("1.0", null), false);
  assert.equal(operationsNegotiated("1.0", '"operations";v="3";v="2"'), false);
  assert.equal(
    operationsNegotiated("1.0", '"operations";v="3", "operations";v="3"'),
    false,
  );
  assert.equal(operationsNegotiated("1.0", '"operations";v="3",'), false);
  assert.throws(() => operationsNegotiated(null, null), /version_unsupported/);
  assert.throws(() => operationsNegotiated("0.3", null), /version_unsupported/);
  assert.throws(() => parseExtensions('operations;v="3"'));
});
test("approval header and MCP metadata are agent-attested, reject malformed and duplicate fields", () => {
  const parsed = parseApprovalHeader(wire);
  assert.deepEqual(parsed, {
    operation_id: "order_1",
    revision: "rev_1",
    approver: "user",
    approved_at: 1791487260,
    input_type: "tap",
    assurance: "agent-attested",
  });
  assert.equal(
    parseMcpApproval({
      "personalagentprotocol.org/approval": {
        operation_id: "order_1",
        revision: "rev_1",
        approver: "user",
        assurance: "merchant-witnessed",
      },
    })?.assurance,
    "agent-attested",
  );
  assert.equal(parseMcpApproval({}), undefined);
  assert.equal(
    parseApprovalHeader(
      'operation_id="order_1", revision="rev_1", approver="agent", input_type="tap"',
    ).input_type,
    undefined,
  );
  for (const bad of [
    wire + ', revision="rev_2"',
    'operation_id="x", revision="y"',
    wire + ",",
    wire.replace("1791487260", "1.0"),
    wire.replace('"user"', "user"),
    wire.replace('"order_1"', '"x y"'),
  ])
    assert.throws(() => parseApprovalHeader(bad));
});
test("operation is immutable, API and MCP expose appropriate wire results", async () => {
  const terms = { amount: 42, nested: { value: "old" } };
  const copy = createOperation({ ...operation, terms });
  terms.nested.value = "new";
  assert.equal((copy.terms.nested as { value: string }).value, "old");
  assert.equal(Object.isFrozen(copy.terms.nested), true);
  const res = approvalRequired(operation);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "approval_required");
  assert.equal(mcpApprovalRequired(operation).isError, true);
  assert.deepEqual(
    mcpApprovalRequired(operation).structuredContent.operation,
    operation,
  );
  const alternative = merchantReviewAlternative(
    "https://shop.example/review/1",
    "https://shop.example",
    "Review yourself",
  );
  const decline = { operation_id: "order_1", revision: "rev_1", alternative };
  assert.equal(
    (await approvalDeclined(decline, "https://shop.example").json()).error,
    "approval_declined",
  );
  assert.equal(
    mcpApprovalDeclined(decline, "https://shop.example").structuredContent
      .error,
    "approval_declined",
  );
  assert.throws(() => approvalDeclined(decline));
  assert.throws(() =>
    merchantReviewAlternative(
      "https://evil.example/review",
      "https://shop.example",
      "Review",
    ),
  );
});
test("discovery advertises only opted-in Operations v3 and refuses wrong host, version and UCP", () => {
  const doc = buildDiscovery({
    domain: "shop.example",
    name: "Shop",
    apis: [
      {
        type: "openapi",
        url: "https://shop.example/openapi.json",
        description: "Shop API",
      },
    ],
    operationsV3: true,
  });
  assert.equal(validateDiscovery(doc, "shop.example"), true);
  assert.equal(validateDiscovery(doc, "evil.example"), false);
  assert.equal(
    validateDiscovery({ ...doc, protocol_version: "0.3" }, "shop.example"),
    false,
  );
  assert.equal(
    validateDiscovery(
      { ...doc, extensions: { ...doc.extensions, ucp: [{ version: "1" }] } },
      "shop.example",
    ),
    false,
  );
  assert.throws(() =>
    buildDiscovery({
      domain: "shop.example",
      name: "Shop",
      apis: [
        { type: "mcp", url: "http://shop.example/mcp", description: "MCP" },
      ],
    }),
  );
});
test("discovery refuses unsupported website operations and extra capabilities", () => {
  const doc = buildDiscovery({
    domain: "shop.example",
    name: "Shop",
    apis: [
      { type: "mcp", url: "https://shop.example/mcp", description: "MCP" },
    ],
    operationsV3: true,
  });
  assert.equal(
    validateDiscovery(
      {
        ...doc,
        web: { browser_session_endpoint: "https://shop.example/join" },
      },
      "shop.example",
    ),
    false,
  );
  assert.equal(
    validateDiscovery(
      {
        ...doc,
        extensions: {
          operations: [
            { version: "3", endpoint: "https://shop.example/operations" },
          ],
        },
      },
      "shop.example",
    ),
    false,
  );
  assert.equal(
    validateDiscovery({ ...doc, auth: { disabled: true } }, "shop.example"),
    false,
  );
  assert.throws(() =>
    buildDiscovery({
      domain: "shop.example",
      name: "Shop",
      apis: doc.apis,
      scopes: { read: 42 } as unknown as Record<string, string>,
    }),
  );
});
