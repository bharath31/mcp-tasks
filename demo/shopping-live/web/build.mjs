import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function repoRoot(from) {
  let dir = from;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "node_modules", "esbuild"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("esbuild not found; run npm ci at the repository root");
}

const rootDir = repoRoot(dirname(fileURLToPath(import.meta.url)));
const { build } = createRequire(join(rootDir, "package.json"))("esbuild");

const root = new URL("./", import.meta.url);
const out = new URL("dist/", root);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: [new URL("src/main.ts", root).pathname],
  outdir: out.pathname,
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
  logLevel: "warning",
});
for (const f of ["index.html", "style.css"]) {
  await copyFile(new URL(f, root), new URL(f, out));
}
await cp(new URL("public/", root), out, { recursive: true });
console.log("built demo/shopping-live/web/dist");