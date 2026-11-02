import { ServiceError } from "./errors.js";

/**
 * Current-permission oracle. The service never caches answers: every
 * protected decision asks FGA again, and any failure is fail-closed.
 */
export interface Fga {
  check(user: string, relation: string, object: string): Promise<boolean>;
}

export class FgaUnavailable extends Error {}

/** Maps any FGA failure to a retryable, fail-closed service error. */
export async function fgaCheck(
  fga: Fga,
  user: string,
  relation: string,
  object: string,
): Promise<boolean> {
  try {
    return await fga.check(user, relation, object);
  } catch {
    throw new ServiceError(
      "authorization_unavailable",
      "Current permissions could not be verified. Nothing was authorized.",
      { dependency: "fga" },
    );
  }
}

export type OpenFgaOptions = {
  apiUrl: string;
  storeId: string;
  modelId?: string;
  /** Static bearer token (OpenFGA preshared key) or a provider for Auth0 FGA client credentials. */
  getToken?: () => Promise<string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

/** Minimal HTTP client for the OpenFGA / Auth0 FGA Check and Write APIs. */
export class OpenFgaHttp implements Fga {
  constructor(private o: OpenFgaOptions) {}
  private async call(path: string, body: unknown) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.o.getToken)
      headers.authorization = `Bearer ${await this.o.getToken()}`;
    const res = await (this.o.fetch ?? fetch)(
      `${this.o.apiUrl}/stores/${this.o.storeId}${path}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 2500),
      },
    );
    if (!res.ok) throw new FgaUnavailable(`fga_${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
  async check(user: string, relation: string, object: string) {
    const out = await this.call("/check", {
      tuple_key: { user, relation, object },
      // Auth0 FGA caches check results for a few seconds by default; a
      // revoked relation must deny on the very next decision.
      consistency: "HIGHER_CONSISTENCY",
      ...(this.o.modelId ? { authorization_model_id: this.o.modelId } : {}),
    });
    return out.allowed === true;
  }
  /** Fixture/admin helpers. The service itself never writes relationships. */
  async write(tuples: Tuple[]) {
    await this.call("/write", {
      writes: { tuple_keys: tuples },
      ...(this.o.modelId ? { authorization_model_id: this.o.modelId } : {}),
    });
  }
  async delete(tuples: Tuple[]) {
    await this.call("/write", {
      deletes: { tuple_keys: tuples },
      ...(this.o.modelId ? { authorization_model_id: this.o.modelId } : {}),
    });
  }
}
export type Tuple = { user: string; relation: string; object: string };
