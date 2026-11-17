/** Reject placeholder workers.dev hostnames that omit the account subdomain. */
const INVALID_MERCHANT_HOSTNAMES = new Set([
  "nominee-shopping-live.workers.dev",
]);

export function merchantOriginConfigured(
  origin: string | undefined,
): origin is string {
  if (typeof origin !== "string" || !origin.startsWith("https://")) {
    return false;
  }
  try {
    const host = new URL(origin).hostname;
    if (!host || INVALID_MERCHANT_HOSTNAMES.has(host)) return false;
    return true;
  } catch {
    return false;
  }
}
