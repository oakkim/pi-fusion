import test from "node:test";
import assert from "node:assert/strict";
import { getPage } from "./app.js";

test("page 1 has first three users", () => {
  assert.deepEqual(getPage(1).map((u) => u.id), [1, 2, 3]);
});

test("page 2 has next three users", () => {
  assert.deepEqual(getPage(2).map((u) => u.id), [4, 5, 6]);
});

test("last page has the remainder", () => {
  assert.deepEqual(getPage(4).map((u) => u.id), [10]);
});
