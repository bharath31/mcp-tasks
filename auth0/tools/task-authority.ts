#!/usr/bin/env -S node --import tsx
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { runApproveInitCli } from "./approve-init.js";
import {
  POLICY_TEMPLATES,
  evaluatePolicy,
  validatePolicy,
} from "../service/src/policies.js";

type CliOptions = {
  baseUrl?: string;
  token?: string;
  fetch?: typeof fetch;
  stdout?: (text: string) => void;
};

/** Policy administration is authenticated by a separate policies:write token. */
export async function runCli(
  argv: string[],
  options: CliOptions = {},
): Promise<number> {
  const output = options.stdout ?? console.log;
  try {
    const [group, command, ...rest] = argv;
    if (group === "approve" && command === "init")
      return await runApproveInitCli(rest, { out: output });
    if (
      group === "policy" &&
      ["init", "check", "explain"].includes(command ?? "")
    )
      return await runOffline(command!, rest, output);
    if (
      group !== "policy" ||
      ![
        "validate",
        "apply",
        "list",
        "activate",
        "simulate",
        "templates",
      ].includes(command ?? "")
    )
      throw new Error(
        "Usage: task-authority approve init --tenant DOMAIN --app-url ORIGIN [--dry-run] | policy init TEMPLATE | check FILE | explain FILE ACTION --args JSON [--actor agent|human|service] | validate|apply FILE [--activate|--shadow] | list RESOURCE_SERVER | activate RESOURCE_SERVER VERSION [--shadow] | simulate RESOURCE_SERVER --version VERSION [--since 30d] | templates",
      );
    const base = options.baseUrl ?? process.env.TASK_AUTHORITY_URL;
    const token = options.token ?? process.env.TASK_AUTHORITY_TOKEN;
    if (!base || !token)
      throw new Error("Set TASK_AUTHORITY_URL and TASK_AUTHORITY_TOKEN.");
    const option = (name: string) => {
      const i = rest.indexOf(name);
      if (i < 0) return undefined;
      const value = rest[i + 1];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing ${name} value.`);
      return value;
    };
    let path = "/v1/policies";
    let method = "GET";
    let body: unknown;
    if (command === "validate" || command === "apply") {
      if (!rest[0] || rest[0].startsWith("--"))
        throw new Error("A JSON policy file is required.");
      const document = JSON.parse(await readFile(rest[0], "utf8"));
      if (command === "validate") {
        path += "/validate";
        method = "POST";
        body = document;
      } else {
        if (typeof document.resource_server !== "string")
          throw new Error("Policy resource_server is required.");
        path += `/${encodeURIComponent(document.resource_server)}`;
        method = "PUT";
        body = {
          document,
          activate: rest.includes("--activate"),
          shadow: rest.includes("--shadow"),
        };
      }
    } else if (command === "templates") path += "/templates";
    else {
      if (!rest[0]) throw new Error("RESOURCE_SERVER is required.");
      path += `/${encodeURIComponent(rest[0])}`;
      if (command === "activate") {
        if (!rest[1] || rest[1].startsWith("--"))
          throw new Error("VERSION is required.");
        path += "/activate";
        method = "POST";
        body = { version: rest[1], shadow: rest.includes("--shadow") };
      } else if (command === "simulate") {
        const version = option("--version");
        if (!version) throw new Error("--version is required.");
        path += "/simulate";
        method = "POST";
        body = { version, since: option("--since") ?? "30d" };
      }
    }
    const response = await (options.fetch ?? fetch)(
      `${base.replace(/\/$/, "")}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    const result = await response.json();
    output(JSON.stringify(result, null, 2));
    return response.ok ? 0 : 1;
  } catch (error) {
    output(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/**
 * Offline authoring: no server or token. `init` prints a template, `check` runs the same
 * validation as publishing (schema, CEL type-check, tiers, budgets), and `explain` evaluates
 * one request against the document the way registration does.
 */
async function runOffline(
  command: string,
  rest: string[],
  output: (text: string) => void,
): Promise<number> {
  if (command === "init") {
    const template = POLICY_TEMPLATES[rest[0] ?? ""];
    if (!template)
      throw new Error(
        `TEMPLATE is one of: ${Object.keys(POLICY_TEMPLATES).join(", ")}.`,
      );
    output(JSON.stringify(template, null, 2));
    return 0;
  }
  if (!rest[0] || rest[0].startsWith("--"))
    throw new Error("A JSON policy file is required.");
  const document = JSON.parse(await readFile(rest[0], "utf8"));
  let policy;
  try {
    policy = validatePolicy(document);
  } catch (error) {
    output(
      `invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  if (command === "check") {
    const rules = Object.values(policy.actions).reduce(
      (n, a) => n + a.rules.length,
      0,
    );
    output(
      `ok: ${policy.resource_server} ${policy.version}, ${Object.keys(policy.actions).length} action(s), ${rules} rule(s)`,
    );
    return 0;
  }
  const action = rest[1];
  if (!action || action.startsWith("--"))
    throw new Error("ACTION is required.");
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i < 0 ? undefined : rest[i + 1];
  };
  const actorType = flag("--actor") ?? "agent";
  if (!["agent", "human", "service"].includes(actorType))
    throw new Error("--actor is agent, human or service.");
  const decision = evaluatePolicy(policy, action, {
    action,
    resource: flag("--resource") ?? "",
    args: JSON.parse(flag("--args") ?? "{}"),
    facts: JSON.parse(flag("--facts") ?? "{}"),
    actor: { type: actorType, id: `${actorType}_cli` },
    relations: {},
    aggregates: {},
  });
  const {
    decision: outcome,
    reasonCode,
    ruleIds,
    tier,
    quorum,
    stepUp,
  } = decision;
  output(
    JSON.stringify(
      { decision: outcome, reasonCode, ruleIds, tier, quorum, stepUp },
      null,
      2,
    ),
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runCli(process.argv.slice(2));
