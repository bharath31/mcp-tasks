// Pushes the Auth0 client ids and secrets from the provisioner's 0600 state file into the Worker's
// secrets with `wrangler secret put`, one by one over stdin. Values never reach stdout, argv or logs.
//
//   node demo/policy-desk/tools/put-secrets.mjs [--state ~/.policy-desk/auth0-state.json] [--apply]
//
// Default is a dry run that lists the secret NAMES that would be set. The Worker must already exist
// (run `wrangler deploy` once first). DATABASE_URL, FGA_* are not in the state file;
// set those yourself with `wrangler secret put <NAME> --config demo/policy-desk/wrangler.jsonc`.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { secretValuesFromState } from "./provision.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const config = resolve(here, "../wrangler.jsonc");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const si = args.indexOf("--state");
const statePath =
  si >= 0 ? args[si + 1] : resolve(homedir(), ".policy-desk/auth0-state.json");

const state = JSON.parse(readFileSync(statePath, "utf8"));
const values = secretValuesFromState(state);
const missing = Object.entries(values)
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(`State file is missing values for: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(
  `${apply ? "Setting" : "Would set"} ${Object.keys(values).length} Worker secrets (names only):`,
);
for (const name of Object.keys(values)) {
  console.log(`  ${name}`);
  if (!apply) continue;
  const r = spawnSync(
    "npx",
    ["wrangler", "secret", "put", name, "--config", config],
    { input: values[name], encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
  if (r.status !== 0) {
    console.error(
      `  failed: ${name}\n${(r.stderr || "").split("\n").slice(-4).join("\n")}`,
    );
    process.exit(1);
  }
}
console.log(apply ? "Done." : "Dry run. Re-run with --apply.");
