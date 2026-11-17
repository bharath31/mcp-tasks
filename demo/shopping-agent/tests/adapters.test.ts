import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkersAiModel,
  parseWorkersAiOutput,
} from "../src/model/workers-ai-adapter.js";
import { createPuppeteerLauncher } from "../src/browser/puppeteer-adapter.js";
import { shoppingAgentConfig } from "../src/config.js";

test("workers ai adapter parses tool calls from OpenAI-shaped output", async () => {
  const calls: unknown[] = [];
  const model = createWorkersAiModel({
    run: async (model, input) => {
      calls.push({ model, input });
      return {
        response: {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "t1",
                    function: { name: "view_catalog", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        },
      };
    },
  });
  const raw = await model.run("@cf/example", {
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    temperature: 0,
    max_completion_tokens: 10,
  });
  const parsed = model.parseOutput(raw);
  assert.deepEqual(parsed.toolCalls, [
    { id: "t1", name: "view_catalog", arguments: "{}" },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(parseWorkersAiOutput(raw).toolCalls.length, 1);
});

test("puppeteer launcher factory wires guardrails option shape", () => {
  const config = shoppingAgentConfig.parse({
    merchantOrigin: "https://shop.example.test",
  });
  const launcher = createPuppeteerLauncher({} as Fetcher, config);
  assert.equal(typeof launcher, "function");
});
