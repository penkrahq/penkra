export interface PossibleModelOptionDescriptor {
  readonly key: string;
  readonly valueType: "string";
  readonly allowedValues: ReadonlyArray<string>;
  readonly allowsCustomValue: boolean;
}

export interface PossibleModelDescriptor {
  readonly provider: string;
  readonly model: string;
  readonly name: string;
  readonly options: ReadonlyArray<PossibleModelOptionDescriptor>;
}

const fixedStringOption = (
  key: string,
  allowedValues: ReadonlyArray<string>,
): PossibleModelOptionDescriptor => ({
  key,
  valueType: "string",
  allowedValues,
  allowsCustomValue: false,
});

const customStringOption = (key: string): PossibleModelOptionDescriptor => ({
  key,
  valueType: "string",
  allowedValues: [],
  allowsCustomValue: true,
});

export const POSSIBLE_MODEL_CATALOG: ReadonlyArray<PossibleModelDescriptor> = [
  ...[
    ["gpt-6-astra", "GPT-6-Astra", ["low", "medium", "high", "xhigh", "max", "ultra"]],
    ["gpt-5.6-sol", "GPT-5.6-Sol", ["low", "medium", "high", "xhigh", "max", "ultra"]],
    ["gpt-5.6-terra", "GPT-5.6-Terra", ["low", "medium", "high", "xhigh", "max", "ultra"]],
    ["gpt-5.6-luna", "GPT-5.6-Luna", ["low", "medium", "high", "xhigh", "max"]],
    ["gpt-5.5", "GPT-5.5", ["low", "medium", "high", "xhigh"]],
  ].map(([model, name, values]) => ({
    provider: "codex",
    model: model as string,
    name: name as string,
    options: [fixedStringOption("reasoningEffort", values as string[])],
  })),
  ...[
    ["claude-sonnet-5", "Sonnet 5", ["low", "medium", "high", "xhigh", "max"]],
    ["claude-fable-5", "Fable 5", ["low", "medium", "high", "xhigh", "max"]],
    ["claude-opus-5", "Opus 5", ["low", "medium", "high", "xhigh", "max"]],
    ["claude-haiku-4-5-20251001", "Haiku 4.5", []],
  ].map(([model, name, values]) => ({
    provider: "claudeAgent",
    model: model as string,
    name: name as string,
    options:
      (values as string[]).length === 0 ? [] : [fixedStringOption("effort", values as string[])],
  })),
  ...[
    ["opencode/big-pickle", "Big Pickle", []],
    ["opencode/ling-3.0-flash-fin-free", "Ling 3.0 Flash Fin Free", ["low", "medium", "high"]],
    ["opencode/mimo-v2.5-free", "MiMo V2.5 Free", []],
    [
      "opencode/muse-spark-1.2-contributor-free",
      "Muse Spark 1.2 Free",
      ["minimal", "low", "medium", "high", "xhigh"],
    ],
    [
      "opencode/muse-spark-1.3-contributor-free",
      "Muse Spark 1.3 Free",
      ["minimal", "low", "medium", "high", "xhigh"],
    ],
    ["opencode/nemotron-3-ultra-free", "Nemotron 3 Ultra Free", []],
    ["opencode/nemotron-3.5-lightning-free", "Nemotron 3.5 Lightning Free", []],
  ].map(([model, name, values]) => ({
    provider: "opencode",
    model: model as string,
    name: name as string,
    options: [
      ...((values as string[]).length === 0
        ? []
        : [fixedStringOption("variant", values as string[])]),
      customStringOption("agent"),
    ],
  })),
  ...[
    ["opencode-go/minimax-m3", "MiniMax M3"],
    ["opencode-go/minimax-m2.7", "MiniMax M2.7"],
    ["opencode-go/minimax-m2.5", "MiniMax M2.5"],
    ["opencode-go/kimi-k3", "Kimi K3"],
    ["opencode-go/kimi-k2.7-code", "Kimi K2.7 Code"],
    ["opencode-go/kimi-k2.6", "Kimi K2.6"],
    ["opencode-go/longcat-2.0", "LongCat 2.0"],
    ["opencode-go/kimi-k2.5", "Kimi K2.5"],
    ["opencode-go/glm-5.2", "GLM 5.2"],
    ["opencode-go/glm-5.3-flash", "GLM 5.3 Flash"],
    ["opencode-go/glm-5.3", "GLM 5.3"],
    ["opencode-go/glm-5.1", "GLM 5.1"],
    ["opencode-go/glm-5", "GLM 5"],
    ["opencode-go/deepseek-v4-pro", "DeepSeek V4 Pro"],
    ["opencode-go/deepseek-v4-flash", "DeepSeek V4 Flash"],
    ["opencode-go/deepseek-flash", "DeepSeek Flash"],
    ["opencode-go/deepseek-v4.1-flash", "DeepSeek V4.1 Flash"],
    ["opencode-go/deepseek-v4-flash-vision-exp", "DeepSeek V4 Flash Vision Exp"],
    ["opencode-go/qwen3.7-max", "Qwen 3.7 Max"],
    ["opencode-go/qwen3.8-max", "Qwen 3.8 Max"],
    ["opencode-go/qwen3.8-flash", "Qwen 3.8 Flash"],
    ["opencode-go/qwen3.7-plus", "Qwen 3.7 Plus"],
    ["opencode-go/qwen3.6-plus", "Qwen 3.6 Plus"],
    ["opencode-go/qwen3.5-plus", "Qwen 3.5 Plus"],
    ["opencode-go/mimo-v2-pro", "MiMo V2 Pro"],
    ["opencode-go/mimo-v2-omni", "MiMo V2 Omni"],
    ["opencode-go/mimo-v2.5-pro", "MiMo V2.5 Pro"],
    ["opencode-go/mimo-v2.5", "MiMo V2.5"],
    ["opencode-go/hy4-preview", "Hy4 Preview"],
    ["opencode-go/hy3", "Hy3"],
    ["opencode-go/hy3-preview", "Hy3 Preview"],
    ["opencode-go/gpt-5.6-luna", "GPT-5.6-Luna"],
    ["opencode-go/grok-4.5", "Grok 4.5"],
    ["opencode-go/grok-4.6", "Grok 4.6"],
    ["opencode-go/muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor"],
    ["opencode-go/muse-spark-1.2-contributor", "Muse Spark 1.2 Contributor"],
    ["opencode-go/omen-alpha", "Omen Alpha"],
  ].map(([model, name]) => ({
    provider: "opencode",
    model: model as string,
    name: name as string,
    options: [customStringOption("agent")],
  })),
];
