import assert from "node:assert/strict";
import test from "node:test";
import { readableError, routeFromHash } from "./model.js";

test("normalizes known routes", () => {
  assert.equal(routeFromHash("#focus"), "focus");
  assert.equal(routeFromHash("#settings"), "settings");
  assert.equal(routeFromHash("#unknown"), "home");
});
test("renders explicit failures", () => assert.equal(readableError(new Error("offline")), "offline"));
