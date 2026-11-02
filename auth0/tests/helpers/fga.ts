import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { transformer } from "@openfga/syntax-transformer";
import type { Tuple } from "@task-authority/test-fixtures";
import { OpenFgaHttp, type Fga } from "../../service/src/fga.js";

export type FgaAdmin = Fga & {
  write(tuples: Tuple[]): Promise<void>;
  delete(tuples: Tuple[]): Promise<void>;
  /** "memory" (deterministic fake) or "openfga" (real OpenFGA server). */
  backend: "memory" | "openfga";
  close(): Promise<void>;
};

const key = (t: Tuple) => `${t.user}|${t.relation}|${t.object}`;

/** Deterministic in-memory fake that mirrors auth0/service/fga/model.fga. */
export class MemoryFga implements FgaAdmin {
  backend = "memory" as const;
  private tuples = new Set<string>();
  async check(user: string, relation: string, object: string) {
    if (this.tuples.has(key({ user, relation, object }))) return true;
    // define delegation_grantor: [user] or admin
    return (
      relation === "delegation_grantor" &&
      this.tuples.has(key({ user, relation: "admin", object }))
    );
  }
  async write(t: Tuple[]) {
    t.forEach((x) => this.tuples.add(key(x)));
  }
  async delete(t: Tuple[]) {
    t.forEach((x) => this.tuples.delete(key(x)));
  }
  async close() {}
}

/** Wraps any Fga with latches and failure injection for race and outage tests. */
export class HookedFga implements FgaAdmin {
  failing = false;
  /** Awaited before every check; swap in a latch to hold a claim inside its lock. */
  gate: ((check: string) => Promise<void>) | null = null;
  checks: string[] = [];
  constructor(private inner: FgaAdmin) {}
  get backend() {
    return this.inner.backend;
  }
  async check(user: string, relation: string, object: string) {
    this.checks.push(`${user} ${relation} ${object}`);
    if (this.gate) await this.gate(`${user} ${relation} ${object}`);
    if (this.failing) throw new Error("fga down (injected)");
    return this.inner.check(user, relation, object);
  }
  write = (t: Tuple[]) => this.inner.write(t);
  delete = (t: Tuple[]) => this.inner.delete(t);
  close = () => this.inner.close();
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });

export const MODEL_PATH = new URL(
  "../../service/fga/model.fga",
  import.meta.url,
);
export async function modelJson() {
  return JSON.parse(
    transformer.transformDSLToJSON(await readFile(MODEL_PATH, "utf8")),
  );
}

/** Starts a real OpenFGA server (in-memory datastore) from OPENFGA_BIN. */
export async function startOpenFga(
  bin: string,
): Promise<FgaAdmin & { apiUrl: string; storeId: string; modelId: string }> {
  const http = await freePort();
  const grpc = await freePort();
  const proc: ChildProcess = spawn(
    bin,
    [
      "run",
      "--datastore-engine",
      "memory",
      "--http-addr",
      `127.0.0.1:${http}`,
      "--grpc-addr",
      `127.0.0.1:${grpc}`,
      "--playground-enabled=false",
      "--metrics-enabled=false",
    ],
    { stdio: "ignore" },
  );
  const api = `http://127.0.0.1:${http}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${api}/healthz`)).ok) break;
    } catch {}
    if (i > 100) throw new Error("OpenFGA did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
  const store = (await (
    await fetch(`${api}/stores`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "task-authority-test" }),
    })
  ).json()) as { id: string };
  const model = (await (
    await fetch(`${api}/stores/${store.id}/authorization-models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(await modelJson()),
    })
  ).json()) as { authorization_model_id?: string };
  if (!model.authorization_model_id)
    throw new Error(`OpenFGA rejected the model: ${JSON.stringify(model)}`);
  const client = new OpenFgaHttp({
    apiUrl: api,
    storeId: store.id,
    modelId: model.authorization_model_id,
  });
  return {
    backend: "openfga",
    apiUrl: api,
    storeId: store.id,
    modelId: model.authorization_model_id,
    check: (u, r, o) => client.check(u, r, o),
    // Idempotent fixture helpers: OpenFGA rejects duplicate writes and missing deletes with 400.
    write: async (t) => {
      for (const x of t)
        await client.write([x]).catch((e) => {
          if (String(e.message) !== "fga_400") throw e;
        });
    },
    delete: async (t) => {
      for (const x of t)
        await client.delete([x]).catch((e) => {
          if (String(e.message) !== "fga_400") throw e;
        });
    },
    close: async () => {
      proc.kill("SIGTERM");
    },
  };
}

export async function makeFga(): Promise<FgaAdmin> {
  const bin = process.env.OPENFGA_BIN;
  return bin ? startOpenFga(bin) : new MemoryFga();
}
