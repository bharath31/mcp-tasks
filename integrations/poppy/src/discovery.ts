export interface DiscoveryOptions {
  domain: string;
  name: string;
  issuer?: string;
  scopes?: Record<string, string>;
  apis: { type: "openapi" | "mcp"; url: string; description: string }[];
  /** Enable only when the application implements all Operations v3 obligations. */
  operationsV3?: boolean;
}
function httpsUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("Expected safe HTTPS URL");
  return url.href;
}
export function buildDiscovery(options: DiscoveryOptions) {
  if (
    !options.name.trim() ||
    !options.domain ||
    options.domain !== new URL(`https://${options.domain}`).host ||
    /[/@?#]/.test(options.domain)
  )
    throw new Error("Invalid organization");
  if (!options.apis.length) throw new Error("At least one API is required");
  const apis = options.apis.map((api) => {
    if (!["openapi", "mcp"].includes(api.type) || !api.description.trim())
      throw new Error("Invalid API");
    return { ...api, url: httpsUrl(api.url) };
  });
  return {
    protocol_version: "1.0" as const,
    organization: { name: options.name, domain: options.domain },
    ...(options.issuer || options.scopes
      ? {
          auth: {
            ...(options.issuer ? { issuer: httpsUrl(options.issuer) } : {}),
            ...(options.scopes ? { scopes: { ...options.scopes } } : {}),
          },
        }
      : {}),
    apis,
    ...(options.operationsV3
      ? { extensions: { operations: [{ version: "3" as const }] } }
      : {}),
  };
}
export function validateDiscovery(
  document: unknown,
  servingHost: string,
): boolean {
  try {
    if (!document || typeof document !== "object") return false;
    const doc = document as ReturnType<typeof buildDiscovery>;
    if (
      doc.protocol_version !== "1.0" ||
      doc.organization.domain.toLowerCase() !== servingHost.toLowerCase()
    )
      return false;
    if (
      doc.extensions &&
      (Object.keys(doc.extensions).some((key) => key !== "operations") ||
        doc.extensions.operations.length !== 1 ||
        doc.extensions.operations[0].version !== "3")
    )
      return false;
    buildDiscovery({
      domain: doc.organization.domain,
      name: doc.organization.name,
      issuer: doc.auth?.issuer,
      scopes: doc.auth?.scopes,
      apis: doc.apis,
      operationsV3: !!doc.extensions,
    });
    return true;
  } catch {
    return false;
  }
}
