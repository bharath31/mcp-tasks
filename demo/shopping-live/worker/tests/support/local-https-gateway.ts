import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:https";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Miniflare } from "miniflare";

type Gateway = {
  origin: string;
  close: () => Promise<void>;
};

function mintLocalhostTls(): { cert: string; key: string; dir: string } {
  const dir = join(tmpdir(), `shopping-live-tls-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" },
  );
  return {
    cert: readFileSync(certPath, "utf8"),
    key: readFileSync(keyPath, "utf8"),
    dir,
  };
}

/**
 * Local Chromium gateway: HTTPS reverse proxy to Miniflare dispatchFetch.
 * This is not Cloudflare Browser Run; it only mirrors secure cookie + origin behavior.
 */
export function startLocalHttpsGateway(
  mf: Miniflare,
  targetOrigin: string,
  port = 8787,
): Promise<Gateway> {
  const tls = mintLocalhostTls();
  return new Promise((resolve, reject) => {
    const server: Server = createServer(
      { cert: tls.cert, key: tls.key },
      (req, res) => {
        const url = new URL(req.url ?? "/", targetOrigin);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (!v || k === "host") continue;
          if (Array.isArray(v)) {
            for (const part of v) headers.append(k, part);
          } else {
            headers.set(k, v);
          }
        }
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          void (async () => {
            try {
              const body =
                req.method === "GET" || req.method === "HEAD"
                  ? undefined
                  : Buffer.concat(chunks);
              const dispatch = await mf.dispatchFetch(url.toString(), {
                method: req.method,
                headers: Object.fromEntries(headers.entries()),
                body,
              });
              res.statusCode = dispatch.status;
              dispatch.headers.forEach((value, key) => {
                if (key.toLowerCase() === "transfer-encoding") return;
                res.setHeader(key, value);
              });
              const payload = await dispatch.arrayBuffer();
              res.end(Buffer.from(payload));
            } catch (err) {
              res.statusCode = 502;
              res.end(String(err));
            }
          })();
        });
      },
    );
    server.on("error", reject);
    server.listen(port, "localhost", () => {
      resolve({
        origin: targetOrigin,
        close: () =>
          new Promise((done, fail) => {
            server.close((err) => {
              rmSync(tls.dir, { recursive: true, force: true });
              if (err) fail(err);
              else done();
            });
          }),
      });
    });
  });
}