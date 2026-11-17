import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function resolveAssetPath(distDir: string, pathname: string): string | null {
  const safe = pathname === "/" || pathname === "" ? "/index.html" : pathname;
  const file = join(distDir, safe.replace(/^\//, ""));
  if (!file.startsWith(distDir)) return null;
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return file;
}

/** Miniflare ASSETS binding — serves the built shopping-live web dist locally (not Cloudflare assets). */
export function createStaticAssetsFetcher(distDir: string) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    const file = resolveAssetPath(distDir, url.pathname);
    if (!file) {
      return new Response("not found", { status: 404 });
    }
    const ext = file.slice(file.lastIndexOf("."));
    const headers = new Headers({
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    if (req.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }
    const stream = createReadStream(file);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers,
    });
  };
}
