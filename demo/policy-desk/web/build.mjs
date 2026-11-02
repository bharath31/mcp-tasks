// Dependency-free build: esbuild (already a root devDependency) bundles src/main.ts.
import { build } from "esbuild";
import { copyFile, cp, mkdir, rm } from "node:fs/promises";
const root = new URL("./", import.meta.url);
const out = new URL("dist/", root);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: [
    new URL("src/main.ts", root).pathname,
    new URL("src/admin.ts", root).pathname,
  ],
  outdir: out.pathname,
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  logLevel: "warning",
});
for (const f of [
  "index.html",
  "style.css",
  "admin.html",
  "admin.css",
  "_headers",
])
  await copyFile(new URL(f, root), new URL(f, out));
// Static files served as is, such as the link-preview image and clip (og/render.ts makes them).
await cp(new URL("public/", root), out, { recursive: true });
console.log("built demo/policy-desk/web/dist");
