export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function problem(
  status: number,
  code: string,
  message: string,
): Response {
  return json({ code, message, error: message }, status);
}

export function serviceUnavailable(code: string, message: string): Response {
  return problem(503, code, message);
}

export function publicOrigin(req: Request, env: { SHOPPING_PUBLIC_ORIGIN?: string }): string {
  const configured = env.SHOPPING_PUBLIC_ORIGIN?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      return new URL(req.url).origin;
    }
  }
  return new URL(req.url).origin;
}

export function secureCookieParts(origin: string): string {
  return origin.startsWith("https:") ? "; Secure" : "";
}