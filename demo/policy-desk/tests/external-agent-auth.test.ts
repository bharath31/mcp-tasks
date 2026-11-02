import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importSPKI,
  jwtVerify,
} from "jose";
import { mintExternalAgentToken } from "../src/auth0.js";
import type { Env } from "../src/env.js";

const capture = () => {
  const sent: Record<string, string>[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ access_token: "t", expires_in: 60 }));
  }) as unknown as typeof globalThis.fetch;
  return { sent, deps: { fetch } as never };
};

describe("external agent client authentication", () => {
  it("signs a private_key_jwt assertion when a private key is configured", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    const env = {
      AUTH0_DOMAIN: "tenant.example.com",
      TASK_AUTHORITY_AUDIENCE: "https://api.example/ta",
      EXTERNAL_AGENT_CLIENT_ID: "ext_client",
      EXTERNAL_AGENT_PRIVATE_KEY: (await exportPKCS8(privateKey)).replace(
        /\n/g,
        "\\n",
      ),
      EXTERNAL_AGENT_KEY_ID: "k1",
    } as Env;
    const { sent, deps } = capture();
    await mintExternalAgentToken(env, deps);
    const body = sent[0]!;
    assert.equal(body.client_secret, undefined);
    assert.equal(
      body.client_assertion_type,
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    );
    const { payload, protectedHeader } = await jwtVerify(
      body.client_assertion!,
      await importSPKI(await exportSPKI(publicKey), "RS256"),
      {
        issuer: "ext_client",
        subject: "ext_client",
        audience: "https://tenant.example.com/",
      },
    );
    assert.equal(protectedHeader.kid, "k1");
    assert.ok(payload.jti);
  });

  it("falls back to the client secret", async () => {
    const env = {
      AUTH0_DOMAIN: "tenant.example.com",
      TASK_AUTHORITY_AUDIENCE: "https://api.example/ta",
      EXTERNAL_AGENT_CLIENT_ID: "ext_client",
      EXTERNAL_AGENT_CLIENT_SECRET: "s",
    } as Env;
    const { sent, deps } = capture();
    await mintExternalAgentToken(env, deps);
    assert.equal(sent[0]!.client_secret, "s");
    assert.equal(sent[0]!.client_assertion, undefined);
  });
});
