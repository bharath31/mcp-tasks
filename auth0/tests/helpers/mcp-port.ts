// A ConnectedMcpSessionPort over fetch, so the OFFICIAL requester in
// @modelcontextprotocol/ext-tasks (withTasks) drives our server. The port does only what a
// 2026-07-28 client transport must: per-request _meta framing and HTTP routing headers.
import type {
  ConnectedMcpSessionPort,
  DispatchOptions,
  JsonRpcResponse,
} from "@modelcontextprotocol/ext-tasks/client";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
const META = "io.modelcontextprotocol";

export function fetchPort(opts: {
  url: string;
  endpointId: string;
  token: () => Promise<string>;
  clientName?: string;
  /** Transport override, e.g. an in-process app handler. Default: global fetch. */
  fetch?: typeof fetch;
}): ConnectedMcpSessionPort & {
  requests: Array<{ method: string; status: number }>;
} {
  const requests: Array<{ method: string; status: number }> = [];
  let nextId = 1;
  return {
    endpointId: opts.endpointId,
    taskCapabilities: { generation: "v2", capabilities: {} },
    invalidated: false,
    requests,
    async dispatch(
      request: Json,
      options?: DispatchOptions,
    ): Promise<JsonRpcResponse> {
      const req = request as { method: string; params?: Record<string, Json> };
      const params = { ...(req.params ?? {}) } as Record<string, Json>;
      params._meta = {
        ...((params._meta as Record<string, Json>) ?? {}),
        [`${META}/protocolVersion`]: "2026-07-28",
        [`${META}/clientInfo`]: {
          name: opts.clientName ?? "ext-tasks-requester",
          version: "0.2.2",
        },
        [`${META}/clientCapabilities`]: {
          extensions: { [`${META}/tasks`]: {} },
        },
      };
      // Header names are case-insensitive: normalize so a library-supplied Mcp-Name and ours merge, not duplicate.
      const headers: Record<string, string> = {};
      const set = (h: Record<string, string> | undefined) => {
        for (const [k, v] of Object.entries(h ?? {}))
          headers[k.toLowerCase()] = v;
      };
      set({
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${await opts.token()}`,
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": req.method,
      });
      if (typeof params.taskId === "string")
        headers["mcp-name"] = params.taskId;
      set(options?.context?.headers as Record<string, string> | undefined);
      const res = await (opts.fetch ?? fetch)(`${opts.url}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...req, jsonrpc: "2.0", id: nextId++, params }),
        signal: options?.signal,
      });
      requests.push({ method: req.method, status: res.status });
      const body = (await res.json()) as {
        result?: Json;
        error?: { code: number; message: string; data?: Json };
      };
      if (body.error) return { kind: "error", error: body.error as never };
      return { kind: "result", result: body.result as never };
    },
    onServerRequest: () => () => {},
    onNotification: () => () => {},
    onInvalidated: () => () => {},
  } as never;
}
