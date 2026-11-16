import { strict as assert } from "node:assert";
import { test } from "node:test";
import { GET, POST, PUT, PATCH, DELETE } from "../app/api/[...path]/route";

test("all shopping API methods fail closed without a backend", async () => {
  for (const handler of [GET, POST, PUT, PATCH, DELETE]) {
    const response = handler();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).code, "shopping_unavailable");
  }
});
