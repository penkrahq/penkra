import { describe, expect, it } from "vitest";
import { ProviderConnectionId, type ProviderModelDescriptor } from "@penkra/contracts";

import { selectConnectivityProbeModel } from "./connectivityProbeModel.ts";

const connectionId = ProviderConnectionId.makeUnsafe("connection-probe");
const model = (slug: string, efforts: string[] = []): ProviderModelDescriptor => ({
  slug,
  name: slug,
  ...(efforts.length > 0 ? { supportedReasoningEfforts: efforts.map((value) => ({ value })) } : {}),
});

describe("selectConnectivityProbeModel", () => {
  it("ranks general-purpose lightweight tiers before stronger catalog models", () => {
    expect(
      selectConnectivityProbeModel({
        connectionId,
        models: [
          model("gpt-6-astra"),
          model("gpt-6-luna", ["high", "low"]),
          model("gpt-5.6-luna", ["medium", "low"]),
        ],
      }),
    ).toEqual({ model: "gpt-5.6-luna", effort: "low" });
    expect(
      selectConnectivityProbeModel({
        connectionId,
        models: [model("claude-sonnet-4.5"), model("claude-haiku-4.5")],
      }),
    ).toEqual({ model: "claude-haiku-4.5" });
    expect(
      selectConnectivityProbeModel({
        connectionId,
        models: [
          model("vendor/deepseek-v4.1-pro"),
          model("vendor/deepseek-v4.1-flash", ["medium", "low"]),
        ],
      }),
    ).toEqual({ model: "vendor/deepseek-v4.1-flash", effort: "low" });
  });

  it("excludes other Connections and specialized models", () => {
    expect(
      selectConnectivityProbeModel({
        connectionId,
        models: [
          { ...model("flash-vision-exp"), availableConnectionIds: [connectionId] },
          { ...model("nano"), availableConnectionIds: [ProviderConnectionId.makeUnsafe("other")] },
          { ...model("luna"), availableConnectionIds: [connectionId] },
        ],
      }),
    ).toEqual({ model: "luna" });
  });

  it("fails closed when the catalog has no recognized lightweight model", () => {
    expect(
      selectConnectivityProbeModel({ connectionId, models: [model("opus"), model("pro")] }),
    ).toBeNull();
  });
});
