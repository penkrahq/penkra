import { assert, it } from "@effect/vitest";

import { THREAD_ITEM_DATA_LIMIT_BYTES, capThreadItemData } from "./threadItemData.ts";

it("returns data unchanged under the limit and null for null", () => {
  assert.equal(capThreadItemData(null), null);
  assert.equal(capThreadItemData("small"), "small");
  const exact = "x".repeat(THREAD_ITEM_DATA_LIMIT_BYTES);
  assert.equal(capThreadItemData(exact), exact);
});

it("truncates data over the limit with the original byte length", () => {
  const big = "x".repeat(THREAD_ITEM_DATA_LIMIT_BYTES + 10);
  const capped = capThreadItemData(big);
  assert.isNotNull(capped);
  assert.deepStrictEqual(JSON.parse(capped!), {
    truncated: true,
    originalBytes: THREAD_ITEM_DATA_LIMIT_BYTES + 10,
    preview: "x".repeat(THREAD_ITEM_DATA_LIMIT_BYTES),
  });
});
