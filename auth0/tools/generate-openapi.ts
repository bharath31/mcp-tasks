// Generates auth0/service/openapi.json from the zod contracts and the
// service route table, so the document cannot drift from the implementation.
// Usage: node --import tsx auth0/tools/generate-openapi.ts [--check]
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { CONTRACT_VERSION, ERROR_CODES } from "@task-authority/contracts";
import { routeTable } from "../service/src/http.js";

const SUMMARY: Record<string, string> = {
  "POST /v1/policies/validate":
    "Validate a constrained approval policy document",
  "GET /v1/policies/templates": "Read safe starting policy templates",
  "PUT /v1/policies/:resourceServer": "Publish an immutable policy version",
  "GET /v1/policies/:resourceServer":
    "List policy versions and active/shadow pointers",
  "POST /v1/policies/:resourceServer/activate":
    "Activate a policy or set its shadow pointer",
  "POST /v1/policies/:resourceServer/simulate":
    "Replay recorded facts and budgets under a candidate version",
  "GET /v1/approval-requests":
    "List approvals the current reviewer is eligible to decide",
  "POST /v1/approval-requests/:id/lease":
    "Take a short exclusive reviewer lease",
  "POST /v1/approval-requests/:id/challenge":
    "Issue a reviewer/key/digest-bound step-up challenge",
  "POST /v1/approval-requests/:id/escalate":
    "Explicitly escalate a pending approval through CIBA",
  "POST /v1/approval-requests/decisions":
    "Atomically decide at most five operation-bound approvals",
  "POST /v1/approval-requests/digest":
    "Build a coalesced, rate-limited reviewer queue digest",
  "POST /v1/provider-events":
    "Reconcile a verified provider event and flag unclaimed effects",
  "POST /v1/delegations":
    "Establish a bounded user- or organization-owned delegation",
  "GET /v1/delegations/:id": "Inspect a delegation",
  "POST /v1/delegations/:id/revoke":
    "Revoke unclaimed authority (serialized with claims)",
  "POST /v1/operations":
    "Register an exact delegated or human-direct operation (idempotent on operationKey)",
  "GET /v1/operations/:id":
    "Inspect the authorization lifecycle of an operation",
  "POST /v1/operations/:id/approval-requests":
    "Request a human decision when required",
  "GET /v1/approval-requests/:id":
    "Read approval progress and the exact operation to review",
  "POST /v1/approval-requests/:id/decisions":
    "Record an authenticated, operation-bound approve/reject",
  "POST /v1/approvals/:id/proof":
    "Redeem an experimental signed approval proof (trusted backend)",
  "POST /v1/operations/:id/claims":
    "Atomic authorize-and-claim immediately before dispatch",
  "POST /v1/operations/:id/outcomes":
    "Attach customer-attested outcome evidence",
  "POST /v1/operations/:id/cancel":
    "Cancel an unclaimed operation (never reverses a claimed one)",
  "GET /v1/operations/:id/audit": "Redacted security decision history",
  "POST /v1/approval-requests/:id/ciba/poll":
    "Poll a CIBA approval for its outcome (trusted backend)",
  "GET /v1/audit":
    "Investigator audit query by correlation id, operation, delegation, type or reason",
  "GET /v1/usage": "Per-tenant operational usage counters (not billing)",
};

export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routeTable) {
    const path = r.template.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}");
    const op: Record<string, unknown> = {
      summary: SUMMARY[`${r.method} ${r.template}`],
      parameters: [
        ...[...r.template.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map(
          (match) => ({
            name: match[1],
            in: "path",
            required: true,
            schema: { type: "string" },
            ...(match[1] === "resourceServer"
              ? { description: "Percent-encoded Auth0 API identifier" }
              : {}),
          }),
        ),
        ...r.query.map((n) => ({
          name: n,
          in: "query",
          required: false,
          schema: { type: "string" },
        })),
        ...(r.idempotent
          ? [
              {
                name: "Idempotency-Key",
                in: "header",
                required: false,
                schema: {
                  type: "string",
                  pattern: "^[A-Za-z0-9_\\-.:]{8,128}$",
                },
              },
            ]
          : []),
        {
          name: "X-Correlation-Id",
          in: "header",
          required: false,
          schema: { type: "string" },
        },
      ],
      security: [{ bearer: [] }],
      responses: {
        "2XX": {
          description: "Success",
          content: { "application/json": { schema: { type: "object" } } },
        },
        default: {
          description: "Error",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApiError" },
            },
          },
        },
      },
    };
    if (r.body)
      op.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: z.toJSONSchema(r.body, { io: "input" }),
          },
        },
      };
    (paths[path] ??= {})[r.method.toLowerCase()] = op;
  }
  paths["/healthz"] = {
    get: {
      summary: "Liveness and datastore readiness (no sensitive details)",
      responses: {
        "200": { description: "ok" },
        "503": { description: "unavailable" },
      },
    },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Task Authority (custom approval backend, experimental)",
      version: CONTRACT_VERSION,
      description:
        "Repository-owned approval backend, embedded in Policy Desk or deployed separately. Not an Auth0 product or public Auth0 API. Generated routes and request schemas; success response schemas and DPoP requirements are not fully modeled. See the service and SDK READMEs.",
    },
    servers: [{ url: "https://task-authority.example" }],
    paths,
    components: {
      securitySchemes: {
        bearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "Backend (M2M) token, or a human token for decisions/reads. Optional X-Task-Authority-Subject header forwards a verified human token.",
        },
      },
      schemas: {
        ApiError: {
          type: "object",
          required: ["code", "message", "correlationId", "retryable"],
          properties: {
            code: { enum: [...ERROR_CODES] },
            message: { type: "string" },
            correlationId: { type: "string" },
            retryable: { type: "boolean" },
            details: { type: "object" },
          },
        },
      },
    },
  };
}

const target = new URL("../service/openapi.json", import.meta.url);
const text = JSON.stringify(buildOpenApi(), null, 2) + "\n";
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8").catch(() => "")) !== text) {
    console.error(
      "openapi.json is out of date: run node --import tsx auth0/tools/generate-openapi.ts",
    );
    process.exit(1);
  }
} else if (import.meta.url === `file://${process.argv[1]}`) {
  await writeFile(target, text);
  console.log("wrote auth0/service/openapi.json");
}
