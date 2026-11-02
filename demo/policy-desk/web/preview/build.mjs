// Builds the console against in-memory fixtures (no Auth0, no Worker) for visual checks:
//   npm run preview:policy-desk, then open http://localhost:8787
// Open /?scene=busy|empty|new|out&lat=250. Never deployed.
import { build } from "esbuild";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
const here = new URL("./", import.meta.url);
const web = new URL("../", here);
const out = new URL("dist/", here);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const swap = {
  name: "preview-fixtures",
  setup(b) {
    b.onResolve({ filter: /^\.\/(api|auth)$/ }, (a) => ({
      path: new URL(a.path === "./api" ? "fixtures.ts" : "auth.ts", here)
        .pathname,
    }));
  },
};
await build({
  entryPoints: [new URL("src/main.ts", web).pathname],
  outdir: out.pathname,
  bundle: true,
  format: "esm",
  target: "es2022",
  plugins: [swap],
  logLevel: "warning",
});
for (const f of ["index.html", "style.css"])
  await copyFile(new URL(f, web), new URL(f, out));
console.log("built demo/policy-desk/web/preview/dist");

if (process.argv.includes("--serve")) {
  const types = { html: "text/html", css: "text/css", js: "text/javascript" };
  createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const file =
      path === "/" || !path.includes(".") ? "index.html" : path.slice(1);
    if (file.includes("..")) return void res.writeHead(404).end();
    try {
      const body = await readFile(new URL(file, out));
      res.writeHead(200, {
        "content-type":
          types[file.split(".").pop()] ?? "application/octet-stream",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  }).listen(8787, () => console.log("preview on http://localhost:8787"));
}
