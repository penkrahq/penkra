import { describe, expect, it } from "vitest";

import { LOCAL_MODEL_CATALOG, findLocalModel, localModelAvailability, localModelForMachine } from "./localModelCatalog.ts";

const GB = 1024 ** 3;

describe("localModelAvailability", () => {
  it("lists every model but disables ones that need more memory, with a reason", () => {
    const big = findLocalModel("ornith-1.5-35b-a3b")!;
    expect(localModelAvailability(big, 16 * GB)).toEqual({
      kind: "insufficient-memory",
      reason: "Needs 32 GB memory — this Mac has 16 GB",
    });
    expect(localModelAvailability(big, 64 * GB)).toEqual({ kind: "available" });
  });

  it("rounds the reported memory so a 16 GB Mac qualifies for 16 GB models", () => {
    expect(localModelAvailability(findLocalModel("qwen3.5-9b")!, 15.9 * GB).kind).toBe("available");
  });

  it("offers at least one model for an 8 GB Mac", () => {
    expect(LOCAL_MODEL_CATALOG.some((m) => localModelAvailability(m, 8 * GB).kind === "available")).toBe(true);
  });
});

describe("localModelForMachine", () => {
  it("gives Ornith 35B a 128K cap only on Macs with 48 GB or more", () => {
    const entry = findLocalModel("ornith-1.5-35b-a3b")!;
    expect(localModelForMachine(entry, 32 * GB).contextTokens).toBe(65_536);
    expect(localModelForMachine(entry, 64 * GB).contextTokens).toBe(131_072);
  });

  it("leaves models without a larger cap unchanged", () => {
    const entry = findLocalModel("qwen3.5-9b")!;
    expect(localModelForMachine(entry, 128 * GB)).toBe(entry);
  });
});
