import assert from "node:assert/strict";
import test from "node:test";
import {
  parseModelOutput,
  parseWorkersAiOutput,
} from "../src/model/workers-ai-adapter.js";

test("parseModelOutput reads top-level tool_calls", () => {
  const parsed = parseModelOutput({
    tool_calls: [
      {
        name: "view_catalog",
        arguments: {},
      },
    ],
  });
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0]!.name, "view_catalog");
  assert.match(parsed.toolCalls[0]!.id, /^call_/);
  assert.equal(parsed.toolCalls[0]!.arguments, "{}");
});

test("parseModelOutput stringifies object arguments", () => {
  const parsed = parseModelOutput({
    choices: [
      {
        message: {
          tool_calls: [
            {
              id: "abc",
              function: {
                name: "add_to_cart",
                arguments: { productId: "tray" },
              },
            },
          ],
        },
      },
    ],
  });
  assert.equal(parsed.toolCalls[0]!.arguments, '{"productId":"tray"}');
});

test("parseWorkersAiOutput unwraps response envelope", () => {
  const parsed = parseWorkersAiOutput({
    response: {
      choices: [
        {
          message: {
            content: "hello",
            tool_calls: [],
          },
        },
      ],
    },
  });
  assert.equal(parsed.content, "hello");
});