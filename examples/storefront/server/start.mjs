import http from "node:http";
import next from "next";
import { fixtureApi } from "./fixture.mjs";

if (process.env.SHOPPING_FIXTURE !== "1")
  throw Error("Set SHOPPING_FIXTURE=1 to start the loopback-only fixture.");
const port = Number(process.env.PORT ?? 3187);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("Invalid fixture port.");
const origin = `http://127.0.0.1:${port}`;
const app = next({
  dev: process.env.NODE_ENV !== "production",
  hostname: "127.0.0.1",
  port,
});
await app.prepare();
const api = fixtureApi(
  process.env.SHOPPING_FIXTURE_DB ?? "./fixture.sqlite",
  origin,
);
const server = http.createServer((req, res) => {
  // Bind and peer check are essential: Host alone is not an access boundary.
  if (
    req.socket.localAddress !== "127.0.0.1" ||
    req.socket.remoteAddress !== "127.0.0.1" ||
    req.headers.host !== `127.0.0.1:${port}` ||
    req.headers.forwarded ||
    req.headers["x-forwarded-for"] ||
    req.headers["x-forwarded-host"] ||
    req.headers["x-forwarded-proto"] ||
    !req.url?.startsWith("/") ||
    req.url.startsWith("//")
  ) {
    res.writeHead(403, { "cache-control": "no-store" });
    res.end("Forbidden");
    return;
  }
  if (req.url.startsWith("/api/")) void api.handle(req, res);
  else void app.getRequestHandler()(req, res);
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Fixture only: ${origin} (never expose through a proxy)`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(() => {
      api.close();
      process.exit(0);
    }),
  );
