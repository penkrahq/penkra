import { describe, expect, it } from "vitest";

import {
  getRuntimeAwareModelCapabilities,
  resolveRuntimeModelDescriptor,
} from "./runtimeModelCapabilities";

describe("Claude runtime model capabilities", () => {
  it("uses discovered capabilities for a future model absent from the static catalog", () => {
    const runtimeModel = {
      slug: "claude-opus-6",
      name: "Opus",
      supportedReasoningEfforts: [{ value: "low" }, { value: "high" }, { value: "max" }],
      supportsFastMode: true,
      supportsThinkingToggle: false,
    } as const;

    const capabilities = getRuntimeAwareModelCapabilities({
      provider: "claudeAgent",
      model: runtimeModel.slug,
      runtimeModel,
    });

    expect(capabilities.reasoningEffortLevels?.map((effort) => effort.value)).toEqual([
      "low",
      "high",
      "max",
    ]);
    expect(capabilities.supportsFastMode).toBe(true);
    expect(capabilities.supportsThinkingToggle).toBe(false);
  });

  it("matches a discovered future model by its canonical runtime identity", () => {
    const runtimeModel = {
      slug: "claude-opus-6",
      name: "Opus",
    };

    expect(
      resolveRuntimeModelDescriptor({
        provider: "claudeAgent",
        model: "claude-opus-6",
        runtimeModels: [runtimeModel],
      }),
    ).toBe(runtimeModel);
  });
});
