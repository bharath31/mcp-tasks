import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Env } from "../src/env.js";
import { legacyRedirect } from "../src/legacy-host.js";

const env = {
  LEGACY_HOSTS: "old.example.com",
  CANONICAL_ORIGIN: "https://new.example",
} as Env;

describe("legacy host redirect", () => {
  it("sends a browser visit to the same path on the canonical origin", () => {
    const r = legacyRedirect(
      new Request("https://old.example.com/approve/abc?x=1"),
      env,
    );
    assert.equal(r?.status, 301);
    assert.equal(
      r?.headers.get("location"),
      "https://new.example/approve/abc?x=1",
    );
  });
  it("never leaves the canonical origin", () => {
    const r = legacyRedirect(
      new Request("https://old.example.com//evil.example/x"),
      env,
    );
    assert.equal(new URL(r!.headers.get("location")!).host, "new.example");
  });
  it("serves API and MCP calls in place", () => {
    const post = new Request("https://old.example.com/mcp", { method: "POST" });
    const authed = new Request("https://old.example.com/mcp", {
      headers: { authorization: "Bearer t" },
    });
    assert.equal(legacyRedirect(post, env), null);
    assert.equal(legacyRedirect(authed, env), null);
  });
  it("leaves other hosts and unconfigured deployments alone", () => {
    assert.equal(
      legacyRedirect(new Request("https://new.example/"), env),
      null,
    );
    assert.equal(
      legacyRedirect(new Request("https://old.example.com/"), {} as Env),
      null,
    );
  });
});
