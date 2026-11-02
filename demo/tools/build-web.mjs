import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
const web = new URL("../refund-desk/web/", import.meta.url);
const out = new URL("dist/", web);
await mkdir(new URL("fonts/", out), { recursive: true });
await build({
  entryPoints: [
    new URL("app.ts", web).pathname,
    new URL("review.tsx", web).pathname,
  ],
  outdir: out.pathname,
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  external: ["fonts/*"],
  splitting: false,
  logLevel: "warning",
});
for (const f of ["index.html", "review.html", "style.css"])
  await copyFile(new URL(f, web), new URL(f, out));
// The approval page uses Geist (SIL Open Font License), served from the app's own origin.
const fonts = new URL("../../node_modules/geist/dist/fonts/", import.meta.url);
for (const [dir, f] of [
  ["geist-sans", "Geist-Variable.woff2"],
  ["geist-mono", "GeistMono-Variable.woff2"],
])
  await copyFile(new URL(`${dir}/${f}`, fonts), new URL(`fonts/${f}`, out));
console.log("built demo/refund-desk/web/dist");
