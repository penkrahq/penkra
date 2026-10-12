import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ServerListProviderUsageInput } from "./server";

describe("account usage requests", () => {
  it("requires connection ids instead of scanning provider-wide history", () => {
    const decode = Schema.decodeUnknownSync(ServerListProviderUsageInput);
    expect(() => decode({ provider: "claudeAgent" })).toThrow();
    expect(decode({ provider: "claudeAgent", connectionIds: ["account"] })).toEqual({
      provider: "claudeAgent",
      connectionIds: ["account"],
    });
    expect(decode({ connectionIds: [] })).toEqual({ connectionIds: [] });
  });
});
