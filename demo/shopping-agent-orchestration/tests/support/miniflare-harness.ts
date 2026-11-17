import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { AgentRunRpc } from "../../src/rpc.js";
import type { ShoppingAgentOrchestrationEnv } from "../../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));

export async function buildHarnessScript(): Promise<string> {
  const bundle = await build({
    entryPoints: [join(here, "../fixtures/harness-worker.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:workers", "@cloudflare/puppeteer"],
    target: "es2023",
  });
  return bundle.outputFiles[0]!.text;
}

export type OrchestrationHarness = {
  mf: Miniflare;
  dispatchRpc: (ownerId: string, body: AgentRunRpc) => Promise<Response>;
  testEnv: (merchantOrigin: string) => ShoppingAgentOrchestrationEnv;
};

class HarnessDoId {
  constructor(readonly name: string) {}
  toString(): string {
    return this.name;
  }
  equals(other: DurableObjectId): boolean {
    return other.toString() === this.name;
  }
}

function harnessNamespace(
  dispatchRpc: (ownerId: string, body: AgentRunRpc) => Promise<Response>,
): DurableObjectNamespace {
  return {
    idFromName(name: string) {
      return new HarnessDoId(name) as unknown as DurableObjectId;
    },
    idFromString(id: string) {
      return new HarnessDoId(id) as unknown as DurableObjectId;
    },
    newUniqueId() {
      return new HarnessDoId(crypto.randomUUID()) as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      const ownerId = id.toString();
      return {
        id,
        fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
          const req = new Request(input, init);
          return req
            .json()
            .then((body) => dispatchRpc(ownerId, body as AgentRunRpc));
        },
      } as DurableObjectStub;
    },
  } as DurableObjectNamespace;
}

export async function startOrchestrationHarness(): Promise<OrchestrationHarness> {
  const script = await buildHarnessScript();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "agent-orchestration-harness",
          modules: true,
          script,
          compatibilityDate: "2026-10-09",
          durableObjects: {
            AGENT_RUNS: { className: "ShoppingAgentRunState", useSQLite: true },
          },
        },
      ],
    }),
  );
  const dispatchRpc = (ownerId: string, body: AgentRunRpc): Promise<Response> =>
    mf.dispatchFetch("http://agent-runs/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nominee-owner-id": ownerId,
      },
      body: JSON.stringify(body),
    }) as Promise<Response>;
  return {
    mf,
    dispatchRpc,
    testEnv: (merchantOrigin: string) => ({
      MERCHANT_ORIGIN: merchantOrigin,
      AI: undefined as never,
      BROWSER: undefined as unknown as Fetcher,
      AGENT_RUNS: harnessNamespace(dispatchRpc),
    }),
  };
}

export async function readRpcJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
