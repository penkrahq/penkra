import { describe, expect, it } from "vitest";

import { LOCAL_MODEL_CATALOG, findLocalModel, localModelAvailability, localModelForMachine } from "./localModelCatalog.ts";
import { localContextWindowOptions } from "./localOpenCodeConfig.ts";

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
  it("defaults Ornith 35B to 128K only on Macs with 48 GB or more", () => {
    const entry = findLocalModel("ornith-1.5-35b-a3b")!;
    expect(localModelForMachine(entry, 32 * GB).defaultContextTokens).toBe(65_536);
    expect(localModelForMachine(entry, 64 * GB).defaultContextTokens).toBe(131_072);
    expect(localModelForMachine(entry, 64 * GB).contextTokens).toBe(262_144);
  });

  it("leaves models without a larger default unchanged", () => {
    const entry = findLocalModel("qwen3.5-9b")!;
    expect(localModelForMachine(entry, 128 * GB)).toBe(entry);
  });
});

describe("localContextWindowOptions", () => {
  it("runs from 8K to the native window, defaulting to the tested one", () => {
    const options = localContextWindowOptions(262_144, 65_536);
    expect(options.map((o) => o.label)).toEqual(["8K", "16K", "32K", "64K", "128K", "256K"]);
    expect(options.find((o) => o.isDefault)?.label).toBe("64K");
  });
});
