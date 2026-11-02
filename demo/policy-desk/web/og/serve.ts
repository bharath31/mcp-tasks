// Serves the preview console (scene=demo) and the SDK's real approval page on one origin,
// so the recorder can follow "Review this refund" exactly as on mcp-tasks.dev. Local only.
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import {
  approvalConfig,
  approvalLink,
  createApprovalRequest,
  handleApprovalRoute,
} from "@task-authority/sdk/approve";

const dist = new URL("../preview/dist/", import.meta.url);
const TYPES: Record<string, string> = {
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
};

export async function serve(port = 0): Promise<{
  origin: string;
  token: string;
  server: Server;
}> {
  let origin = "";
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", origin);
    try {
      if (url.pathname === "/approve" || url.pathname.startsWith("/approve/")) {
        const r = await handleApprovalRoute(
          new Request(url, { method: req.method }),
          cfg(),
          { appName: "Policy Desk", deliver: async () => {} },
        );
        if (!r) return void res.writeHead(404).end();
        res.writeHead(r.status, Object.fromEntries(r.headers));
        return void res.end(await r.text());
      }
      const file =
        url.pathname === "/" || !url.pathname.includes(".")
          ? "index.html"
          : url.pathname.slice(1);
      if (file.includes("..")) return void res.writeHead(404).end();
      const body = await readFile(new URL(file, dist));
      res.writeHead(200, {
        "content-type":
          TYPES[file.split(".").pop()!] ?? "application/octet-stream",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
  const a = server.address();
  origin = `http://127.0.0.1:${typeof a === "object" && a ? a.port : port}`;
  const cfg = () =>
    approvalConfig(
      {},
      {
        domain: "policy-desk.example.auth0.com",
        clientId: "preview",
        clientSecret: "preview-only-not-a-secret",
        appUrl: origin,
      },
    );
  // The same request shape demo/policy-desk/src/refunds.ts registers for a held refund.
  const request = await createApprovalRequest({
    action: "refund:create",
    resource: "payment:ORD-1042",
    args: { orderId: "ORD-1042", amountMinor: 13900, currency: "USD" },
    approvers: { roles: ["finance"] },
    requester: "Refund agent",
    summary: "Refund 139.00 USD for order ORD-1042",
    expiresIn: "15 minutes",
    run: "op_7f3a91",
    step: "refund:create ORD-1042",
  });
  const link = new URL(await approvalLink(cfg(), request));
  return { origin, token: link.searchParams.get("r")!, server };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { origin, token } = await serve(Number(process.argv[2] ?? 8788));
  console.log(`${origin}/?scene=demo&r=${encodeURIComponent(token)}`);
}
