import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

/** Any OAuth client token works; the CLI has no approval authority or provider credentials. */
export async function refundCli(options: {
  baseUrl: string;
  accessToken: string;
  refund: unknown;
  wait?: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  print?: (text: string) => void;
}): Promise<number> {
  const fetcher = options.fetch ?? fetch;
  const print = options.print ?? console.log;
  const headers = {
    authorization: `Bearer ${options.accessToken}`,
    "content-type": "application/json",
  };
  const base = options.baseUrl.replace(/\/$/, "");
  const response = await fetcher(`${base}/v1/refunds`, {
    method: "POST",
    headers,
    body: JSON.stringify(options.refund),
    redirect: "error",
  });
  let body = (await response.json()) as Record<string, any>;
  print(JSON.stringify(body));
  if (response.status === 401) {
    print(
      response.headers.get("www-authenticate") ??
        "Sign in again with the required assurance.",
    );
    return 2;
  }
  if (!response.ok) return 1;
  if (!options.wait || response.status !== 202) return 0;
  const location = response.headers.get("location");
  if (!location) throw new Error("operation_location_missing");
  const operationUrl = new URL(location, base);
  if (operationUrl.origin !== new URL(base).origin)
    throw new Error("operation_location_origin_mismatch");
  const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
  while (Date.now() < deadline) {
    const poll = await fetcher(operationUrl, { headers, redirect: "error" });
    body = (await poll.json()) as Record<string, any>;
    if (!poll.ok) {
      print(JSON.stringify(body));
      return 1;
    }
    if (["rejected", "denied", "failed", "completed"].includes(body.status)) {
      print(JSON.stringify(body));
      return body.status === "completed" ? 0 : 1;
    }
    await (
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    )(2000);
  }
  print(
    "Timed out waiting for the operation; it remains available at its operation URL.",
  );
  return 3;
}

/** Native-client device authorization, with no client secret or token written to disk. */
export async function deviceLogin(options: {
  domain: string;
  clientId: string;
  audience: string;
  organization?: string;
  fetch?: typeof fetch;
  print?: (s: string) => void;
  sleep?: (ms: number) => Promise<void>;
}) {
  const send = async (path: string, fields: Record<string, string>) => {
    const response = await (options.fetch ?? fetch)(
      `https://${options.domain}/${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
      },
    );
    return { response, body: (await response.json()) as Record<string, any> };
  };
  const start = await send("oauth/device/code", {
    client_id: options.clientId,
    audience: options.audience,
    scope: "openid profile",
    ...(options.organization ? { organization: options.organization } : {}),
  });
  if (!start.response.ok) throw new Error("device_authorization_failed");
  (options.print ?? console.log)(
    `${start.body.verification_uri_complete ?? start.body.verification_uri}  Code: ${start.body.user_code}`,
  );
  let interval = Number(start.body.interval ?? 5) * 1000;
  const deadline = Date.now() + Number(start.body.expires_in) * 1000;
  while (Date.now() < deadline) {
    await (options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(
      interval,
    );
    const result = await send("oauth/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: start.body.device_code,
      client_id: options.clientId,
    });
    if (result.response.ok) return String(result.body.access_token);
    if (result.body.error === "slow_down") interval += 5000;
    else if (result.body.error !== "authorization_pending")
      throw new Error(`device_login_${result.body.error}`);
  }
  throw new Error("device_login_expired");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error(
      "Usage: npm run refund -w @task-authority/refund-desk -- request.json [--wait] [--login]",
    );
    process.exitCode = 1;
  } else {
    const need = (key: string) => {
      const value = process.env[key];
      if (!value) throw new Error(`Missing ${key}`);
      return value;
    };
    const token = args.includes("--login")
      ? await deviceLogin({
          domain: need("AUTH0_DOMAIN"),
          clientId: need("REFUND_CLI_CLIENT_ID"),
          audience: need("MCP_AUDIENCE"),
          organization: process.env.REFUND_ORGANIZATION_ID,
        })
      : need("REFUND_ACCESS_TOKEN");
    process.exitCode = await refundCli({
      baseUrl: need("PUBLIC_URL"),
      accessToken: token,
      refund: JSON.parse(await readFile(file, "utf8")),
      wait: args.includes("--wait"),
    });
  }
}
