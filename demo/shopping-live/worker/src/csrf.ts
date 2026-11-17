import { CSRF_HEADER } from "./env.js";
import { publicOrigin } from "./http.js";
import type { ShoppingLiveEnv } from "./env.js";

export function assertSameOrigin(req: Request, env: ShoppingLiveEnv): Response | null {
  const origin = publicOrigin(req, env);
  const requestOrigin = req.headers.get("origin");
  if (requestOrigin !== origin) {
    return new Response(
      JSON.stringify({
        code: "csrf_origin",
        message: "Cross-origin mutation blocked.",
      }),
      {
        status: 403,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      },
    );
  }
  return null;
}

export function sessionCsrfToken(sid: string): string {
  return sid;
}