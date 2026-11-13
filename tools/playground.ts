#!/usr/bin/env -S node --import tsx
/** Offline policy evaluation, using the same validator and evaluator as the service. */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  POLICY_TEMPLATES,
  evaluatePolicy,
  validatePolicy,
  type PolicyDocument,
} from "../auth0/service/src/policies.js";

const USAGE = `Usage: npm run playground -- [--amount-minor INTEGER] [--policy FILE]

No accounts, Docker or server needed. Evaluates refund policy for a sample agent.
  --amount-minor 150000  Try a $1,500.00 USD refund (amounts are integer cents)
  --policy refunds.json Use your own refund policy instead of the built-in template
  --help                Show this help

To create an editable policy (the --silent keeps npm logs out of the JSON):
  npm run --silent task-authority -- policy init refunds > refunds.json`;

export function evaluateExample(
  policy: PolicyDocument,
  amountMinor: number,
  action = "refund:create",
) {
  return evaluatePolicy(policy, action, {
    action,
    resource: "payment:playground",
    args: { amountMinor, currency: "usd" },
    facts: {},
    actor: { type: "agent", id: "playground_agent" },
    relations: {},
    aggregates: {},
  });
}

export async function main(
  argv: string[],
  out: (line: string) => void = console.log,
): Promise<number> {
  try {
    let amount: number | undefined;
    let file: string | undefined;
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === "--help" || flag === "-h") {
        out(USAGE);
        return 0;
      }
      if (flag !== "--amount-minor" && flag !== "--policy")
        throw new Error(
          `Unknown argument: ${flag}. Run npm run playground -- --help.`,
        );
      const value = argv[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`${flag} needs a value.`);
      if (flag === "--policy") file = value;
      else {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
          throw new Error(
            "--amount-minor must be a non-negative safe integer in cents (150000 = $1,500.00).",
          );
        amount = Number(value);
      }
    }

    const policy = validatePolicy(
      file
        ? JSON.parse(await readFile(file, "utf8"))
        : POLICY_TEMPLATES.refunds,
    );
    out(
      `\nMCP Tasks · policy playground\nPolicy: ${policy.version}${file ? ` (${file})` : " (built-in refunds template)"}\n`,
    );
    const examples =
      amount === undefined
        ? [
            { amount: 5000, action: "refund:create" },
            { amount: 15000, action: "refund:create" },
            { amount: 150000, action: "refund:create" },
            { amount: 5000, action: "refund:unlisted" },
          ]
        : [{ amount, action: "refund:create" }];
    const money = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    });
    for (const example of examples) {
      const result = evaluateExample(policy, example.amount, example.action);
      out(
        `${money.format(example.amount / 100).padEnd(12)} ${example.action.padEnd(17)} → ${result.decision}`,
      );
      out(
        `             ${result.reasonCode}; rules: ${result.ruleIds.join(", ") || "(default)"}${result.tier ? `; tier: ${result.tier}` : ""}${result.quorum ? `; reviewers: ${result.quorum}` : ""}`,
      );
      if (result.budgetRuleIds.length)
        out(
          `             Budget rules: ${result.budgetRuleIds.join(", ")} (usage enforced by the running service)`,
        );
    }
    out(
      "\nOffline evaluation only: sample actor, no identity or FGA checks, no live budget usage, no approvals or payments.",
    );
    out(
      "\nTry a different amount:\n  npm run playground -- --amount-minor 10001",
    );
    out(
      "\nEdit the rules:\n  npm run --silent task-authority -- policy init refunds > refunds.json\n  npm run playground -- --policy refunds.json\n\nSee docs/approval-policy.md for publishing and enforcement.",
    );
    return 0;
  } catch (error) {
    out(
      `Playground: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2));
