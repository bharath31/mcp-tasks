// "Connect your agent": the visitor's own agent (Claude Code, or another MCP 2026-07-28 client) joins this
// sandbox with a key bound to it. The key is shown once, kept only in this panel's memory,
// and stops working when it is replaced, disconnected or the sandbox goes away.
import type { Ctx } from "./ctx";
import { ago, clear, fold, h, json } from "./dom";
import type { AgentKey, AgentKeyStatus } from "./types";

function copyButton(text: () => string, label = "Copy") {
  const b = h("button", { class: "btn small", type: "button" }, label);
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text());
      b.textContent = "Copied";
    } catch {
      b.textContent = "Select and copy";
    }
    setTimeout(() => (b.textContent = label), 1600);
  });
  return b;
}

function snippet(title: string, text: string) {
  return h(
    "div",
    { class: "connect-snippet" },
    h(
      "div",
      { class: "row" },
      h("span", { class: "dim" }, title),
      h("span", { class: "spacer" }),
      copyButton(() => text),
    ),
    h("pre", { class: "mono" }, text),
  );
}

/** A first call any client can make: this server speaks MCP 2026-07-28 only. */
function firstCall(url: string, token: string) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {
          extensions: { "io.modelcontextprotocol/tasks": {} },
        },
      },
    },
  };
  return [
    `curl -s ${url} \\`,
    `  -H 'authorization: Bearer ${token}' \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d '${JSON.stringify(body)}'`,
  ].join("\n");
}

export function connectPanel(ctx: Ctx): HTMLElement {
  const body = h("div", { class: "stack connect-body" });
  const el = fold(
    "connect",
    "Connect your own agent",
    "Claude Code or any MCP client",
    h(
      "p",
      { class: "dim" },
      "Run the same refunds from Claude Code 2.1.310 or later, or any client that speaks MCP 2026-07-28. Your agent gets a key for this sandbox only; held refunds still wait in Reviews for your passkey.",
    ),
    body,
  );
  let status: AgentKeyStatus | undefined;
  let fresh: AgentKey | undefined;

  const act = (label: string, fn: () => Promise<void>, primary = false) => {
    const b = h(
      "button",
      { class: `btn small${primary ? " primary" : ""}`, type: "button" },
      label,
    );
    b.addEventListener("click", async () => {
      b.disabled = true;
      b.setAttribute("aria-busy", "true");
      try {
        await fn();
      } catch (e) {
        ctx.flash((e as Error).message, "bad");
      } finally {
        b.disabled = false;
        b.removeAttribute("aria-busy");
      }
      draw();
    });
    return b;
  };
  const issue = async () => {
    fresh = await ctx.api.connectAgent();
    status = await ctx.api.agentKey();
  };
  const disconnect = async () => {
    await ctx.api.disconnectAgent();
    fresh = undefined;
    status = await ctx.api.agentKey();
    ctx.flash("Agent disconnected. Its key no longer works.", "ok");
  };

  function draw() {
    clear(body);
    if (!status) return;
    if (!status.available) {
      body.append(
        h(
          "p",
          { class: "dim" },
          "Not set up on this deployment yet. The built-in agent above works as usual.",
        ),
      );
      return;
    }
    if (fresh) {
      body.append(
        snippet("Claude Code", fresh.claudeCode),
        h(
          "details",
          {},
          h("summary", {}, "Other MCP clients"),
          h(
            "div",
            { class: "stack" },
            snippet("Streamable HTTP endpoint", fresh.mcpUrl),
            snippet("Authorization header", `Bearer ${fresh.token}`),
            snippet(".mcp.json", json(fresh.mcpJson)),
            h(
              "p",
              { class: "dim" },
              "This endpoint speaks MCP 2026-07-28 only: there is no initialize handshake, so clients built for 2025 revisions fail to connect. Every request carries ",
              h("code", {}, '_meta["io.modelcontextprotocol/protocolVersion"]'),
              ' = "2026-07-28", and request_refund and tasks/* also need ',
              h(
                "code",
                {},
                '_meta["io.modelcontextprotocol/clientCapabilities"]',
              ),
              " to declare the io.modelcontextprotocol/tasks extension. Claude Code 2.1.310 or later does this for you.",
            ),
            snippet("First call (curl)", firstCall(fresh.mcpUrl, fresh.token)),
          ),
        ),
        h(
          "div",
          { class: "notice" },
          h("b", {}, "Shown once. "),
          "Paste it now. Ask your agent for a refund, and it uses request_refund as an MCP task. Creating a new key replaces this one.",
        ),
        h(
          "div",
          { class: "row" },
          act("Disconnect", disconnect),
          act("New key", issue),
        ),
      );
      return;
    }
    if (status.connected) {
      body.append(
        h(
          "p",
          {},
          h("b", {}, "An agent key is active. "),
          status.lastUsedAt
            ? `Last call ${ago(status.lastUsedAt)}.`
            : "Your agent has not called yet.",
        ),
        h(
          "div",
          { class: "row" },
          act("Disconnect", disconnect),
          act("New key", issue, true),
        ),
      );
      return;
    }
    body.append(
      h("div", { class: "row" }, act("Create agent key", issue, true)),
    );
  }

  void ctx.api.agentKey().then(
    (s) => {
      status = s;
      draw();
    },
    () => {
      status = undefined;
      clear(body);
    },
  );
  return el;
}
