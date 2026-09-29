import { ProviderConnectionId, type ProviderModelDescriptor } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import { selectNativeResumeProbeModel } from "./nativeResumeProbeModel.ts";

const connectionId = ProviderConnectionId.makeUnsafe("probe-connection");
const model = (slug: string): ProviderModelDescriptor => ({ slug, name: slug });

describe("selectNativeResumeProbeModel", () => {
  it("prefers Haiku and falls back to Sonnet only when Haiku is unavailable", () => {
    expect(
      selectNativeResumeProbeModel({
        provider: "claudeAgent",
        connectionId,
        models: [model("claude-opus-5"), model("claude-sonnet-5"), model("claude-haiku-4-5")],
      }),
    ).toBe("claude-haiku-4-5");
    expect(
      selectNativeResumeProbeModel({
        provider: "claudeAgent",
        connectionId,
        models: [
          { ...model("claude-haiku-4-5"), availableConnectionIds: [] },
          model("claude-sonnet-5"),
        ],
      }),
    ).toBe("claude-sonnet-5");
    expect(
      selectNativeResumeProbeModel({
        provider: "claudeAgent",
        connectionId,
        models: [model("claude-opus-5")],
      }),
    ).toBeNull();
  });

  it("holds the requested preferences for Codex and OpenCode", () => {
    expect(
      selectNativeResumeProbeModel({
        provider: "codex",
        connectionId,
        models: [model("gpt-6-astra"), model("gpt-6-luna")],
      }),
    ).toBe("gpt-6-luna");
    expect(
      selectNativeResumeProbeModel({
        provider: "opencode",
        connectionId,
        models: [model("opencode-go/deepseek-v4.1-flash")],
      }),
    ).toBe("opencode-go/deepseek-v4.1-flash");
  });
});
