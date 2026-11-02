// Enforces the demo / service / SDK / shared boundaries and scans tracked
// files for secrets. Exit 1 on any violation. Run: node auth0/tools/check-boundaries.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean)
  .filter((f) => !/package-lock\.json$|\.(png|ico|jpg)$/.test(f));
const read = (f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
};
const violations = [];
const importsOf = (src) =>
  [...src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
    (m) => m[1],
  );
const rule = (name, test) => {
  for (const f of files) {
    const msg = test(f);
    if (msg) violations.push(`${name}: ${f}: ${msg}`);
  }
};

// 1. Demo apps never import service internals, fixtures or tests; use only the SDK.
rule("customer-boundary", (f) => {
  if (!/^demo\/(refund-desk|deploy-gate)\/.*\.ts$/.test(f)) return;
  for (const i of importsOf(read(f)))
    if (
      /(^|\/)auth0\/(service|fixtures)|test-fixtures|^(\.\.\/)+(auth0|tests)\/|@task-authority\/(service|test-fixtures)/.test(
        i,
      )
    )
      return `forbidden import ${i}`;
});
// 2. Demo code and database own no grant/approval/claim state and do no FGA checks.
rule("no-customer-authz-state", (f) => {
  if (!/^demo\/(refund-desk|deploy-gate)\/.*\.(ts|sql)$/.test(f)) return;
  const s = read(f);
  if (
    /\b(from|join|into|update)\s+authority\.(delegations|operations|approvals|claims|audit_events)/i.test(
      s,
    )
  )
    return "reads service tables";
  if (/create table[^;]*\b(delegation|approval|claim|grant)s?\b/i.test(s))
    return "defines an authorization table";
  if (
    /tuple_key|\/check\b|openfga|registered_agent|trusted_backend/i.test(s) &&
    !/app\.ts$/.test(f)
  )
    return "performs FGA checks";
});
// 3. The SDK depends only on shared contracts (no service internals, no apps).
// approve/ also uses jose: verifying Auth0-signed proofs locally is its whole job.
rule("sdk-boundary", (f) => {
  if (!/^auth0\/sdk\/src\/.*\.ts$/.test(f)) return;
  const allowed = f.startsWith("auth0/sdk/src/approve/")
    ? ["@task-authority/contracts", "jose"]
    : ["@task-authority/contracts"];
  for (const i of importsOf(read(f)))
    if (!i.startsWith(".") && !allowed.includes(i))
      return `unexpected dependency ${i}`;
});
// 4. Shared contracts are schemas/types only: no server, SDK or app imports.
rule("contracts-boundary", (f) => {
  if (!/^auth0\/contracts\/src\/.*\.ts$/.test(f)) return;
  for (const i of importsOf(read(f)))
    if (!i.startsWith(".") && i !== "zod") return `unexpected dependency ${i}`;
});
// 5. The service never imports demo apps or SDK client code. One narrow exception
// is the pure Auth0 proof verifier used by the approve() -> Task Authority bridge.
rule("service-boundary", (f) => {
  if (!/^auth0\/service\/.*\.ts$/.test(f)) return;
  for (const i of importsOf(read(f)))
    if (
      f === "auth0/service/src/approvals.ts" &&
      i === "@task-authority/sdk/approve/verify"
    )
      continue;
    else if (
      /^(\.\.\/)+(demo|auth0\/(sdk|tests|tools|fixtures|actions))\/|@auth0\/task-authority|@task-authority\/refund-desk/.test(
        i,
      )
    )
      return `forbidden import ${i}`;
});
// 5b. The approval UI renders service records and posts decisions; it never imports the
// service, the SDK or demo code, so any app (or a hosted page) can embed it.
rule("approval-ui-boundary", (f) => {
  if (!/^auth0\/approval-ui\/src\/.*\.tsx?$/.test(f)) return;
  for (const i of importsOf(read(f)))
    if (
      !i.startsWith(".") &&
      !/^(react|react-dom|@auth0\/auth0-react|lucide-react|@task-authority\/contracts)$/.test(
        i,
      )
    )
      return `unexpected dependency ${i}`;
});
// 6. Secrets and privileged material.
const SECRETS = [
  [/sk_live_[A-Za-z0-9]{10,}/, "Stripe live key"],
  [/\b[sr]k_test_[A-Za-z0-9]{24,}/, "Stripe test key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/eyJ[A-Za-z0-9_-]{30,}\.eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}/, "JWT"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [
    /(client_secret|CLIENT_SECRET|SERVICE_ROLE_KEY)\s*[:=]\s*["'][A-Za-z0-9_\-]{24,}["']/,
    "hard-coded credential",
  ],
  [
    /postgres(ql)?:\/\/[^:\s/]+:(?!<password>|local-only|customer-pw|\$\{)[^@\s]{6,}@(?!127\.0\.0\.1|localhost)/,
    "database URL with password",
  ],
];
rule("secret-scan", (f) => {
  if (/^auth0\/tests\/helpers\/(idp|desk-child)\.ts$/.test(f)) return;
  const s = read(f);
  for (const [re, label] of SECRETS) if (re.test(s)) return label;
});

if (violations.length) {
  console.error(violations.join("\n"));
  console.error(`\n${violations.length} boundary/secret violation(s)`);
  process.exit(1);
}
console.log(`boundaries ok (${files.length} files scanned)`);
