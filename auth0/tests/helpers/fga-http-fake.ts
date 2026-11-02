// OpenFGA-HTTP-API-compatible fake (check + write) over MemoryFga, for full-stack tests when no
// real OpenFGA binary is available. The service's own OpenFgaHttp client talks to it for real.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Tuple } from "@task-authority/test-fixtures";
import { MemoryFga } from "./fga.js";

export async function startFakeFgaServer(): Promise<{
  apiUrl: string;
  storeId: string;
  modelId: string;
  fga: MemoryFga;
  server: Server;
  close(): Promise<void>;
}> {
  const fga = new MemoryFga();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : {};
    const send = (s: number, o: unknown) => {
      res.writeHead(s, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (req.method === "POST" && req.url === "/stores/s1/check") {
      // The service must never accept a cached answer.
      if (body.consistency !== "HIGHER_CONSISTENCY")
        return send(400, { code: "validation_error" });
      const t = body.tuple_key as Tuple;
      return send(200, {
        allowed: await fga.check(t.user, t.relation, t.object),
      });
    }
    if (req.method === "POST" && req.url === "/stores/s1/write") {
      await fga.write((body.writes?.tuple_keys ?? []) as Tuple[]);
      await fga.delete((body.deletes?.tuple_keys ?? []) as Tuple[]);
      return send(200, {});
    }
    send(404, { code: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    storeId: "s1",
    modelId: "m1",
    fga,
    server,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
