import test from "node:test";
import assert from "node:assert/strict";
import { loadData } from "./util.js";
import { getA } from "./a.js";
import { getB } from "./b.js";
import { getC } from "./c.js";

test("loadData reads the store", () => {
  assert.equal(loadData("a"), 1);
  assert.equal(loadData("zzz"), null);
});

test("wrappers still work after rename", () => {
  assert.equal(getA(), 1);
  assert.equal(getB(), 2);
  assert.equal(getC(), 3);
});
