import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";
import type { ProviderKind } from "./orchestration";

export const CODEX_REASONING_EFFORT_OPTIONS = ["low", "medium", "high", "xhigh"] as const;
// Codex app-server can add model-specific efforts through runtime discovery.
export type CodexReasoningEffort = string;
export const CLAUDE_API_EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeApiEffort = (typeof CLAUDE_API_EFFORT_OPTIONS)[number];
export const CLAUDE_PROMPT_MODE_OPTIONS = ["ultrathink"] as const;
export type ClaudePromptMode = (typeof CLAUDE_PROMPT_MODE_OPTIONS)[number];
export const CLAUDE_CODE_MODE_OPTIONS = ["ultracode"] as const;
export type ClaudeCodeMode = (typeof CLAUDE_CODE_MODE_OPTIONS)[number];
export const CLAUDE_CODE_EFFORT_OPTIONS = [
  ...CLAUDE_API_EFFORT_OPTIONS,
  ...CLAUDE_PROMPT_MODE_OPTIONS,
  ...CLAUDE_CODE_MODE_OPTIONS,
] as const;
export type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORT_OPTIONS)[number];
export type ProviderReasoningEffort = CodexReasoningEffort | ClaudeCodeEffort;

export const ProviderOptionChoice = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  isDefault: Schema.optional(Schema.Literal(true)),
});
export type ProviderOptionChoice = typeof ProviderOptionChoice.Type;

const ProviderOptionDescriptorBase = {
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
} as const;

export const SelectProviderOptionDescriptor = Schema.Struct({
  ...ProviderOptionDescriptorBase,
  type: Schema.Literal("select"),
  options: Schema.Array(ProviderOptionChoice),
  currentValue: Schema.optional(TrimmedNonEmptyString),
  promptInjectedValues: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type SelectProviderOptionDescriptor = typeof SelectProviderOptionDescriptor.Type;

export const BooleanProviderOptionDescriptor = Schema.Struct({
  ...ProviderOptionDescriptorBase,
  type: Schema.Literal("boolean"),
  currentValue: Schema.optional(Schema.Boolean),
});
export type BooleanProviderOptionDescriptor = typeof BooleanProviderOptionDescriptor.Type;

export const ProviderOptionDescriptor = Schema.Union([
  SelectProviderOptionDescriptor,
  BooleanProviderOptionDescriptor,
]);
export type ProviderOptionDescriptor = typeof ProviderOptionDescriptor.Type;

export const ProviderOptionSelection = Schema.Struct({
  id: TrimmedNonEmptyString,
  value: Schema.Union([TrimmedNonEmptyString, Schema.Boolean]),
});
export type ProviderOptionSelection = typeof ProviderOptionSelection.Type;

export const ProviderOptionSelections = Schema.Array(ProviderOptionSelection);
export type ProviderOptionSelections = typeof ProviderOptionSelections.Type;

export const CodexModelOptions = Schema.Struct({
  // Codex runtime discovery can expose early-access effort values outside the built-in enum.
  reasoningEffort: Schema.optional(TrimmedNonEmptyString),
  fastMode: Schema.optional(Schema.Boolean),
});
export type CodexModelOptions = typeof CodexModelOptions.Type;

export const ClaudeModelOptions = Schema.Struct({
  thinking: Schema.optional(Schema.Boolean),
  effort: Schema.optional(Schema.Literals(CLAUDE_CODE_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
  autoCompactWindow: Schema.optional(Schema.String),
  // Legacy persisted field. Normalization migrates this to autoCompactWindow.
  contextWindow: Schema.optional(Schema.String),
});
export type ClaudeModelOptions = typeof ClaudeModelOptions.Type;

export const OpenCodeModelOptions = Schema.Struct({
  variant: Schema.optional(TrimmedNonEmptyString),
  agent: Schema.optional(TrimmedNonEmptyString),
});
export type OpenCodeModelOptions = typeof OpenCodeModelOptions.Type;

export const ProviderModelOptions = Schema.Struct({
  codex: Schema.optional(CodexModelOptions),
  claudeAgent: Schema.optional(ClaudeModelOptions),
  opencode: Schema.optional(OpenCodeModelOptions),
});
export type ProviderModelOptions = typeof ProviderModelOptions.Type;

export type ReasoningControlSource = "api-effort" | "provider-setting" | "prompt-prefix";

type EffortOptionBase = {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly isDefault?: true;
};

export type EffortOption =
  | (EffortOptionBase & {
      readonly controlSource?: "api-effort";
      readonly apiEffortValue?: never;
    })
  | (EffortOptionBase & {
      readonly controlSource: "provider-setting";
      readonly apiEffortValue: string;
    })
  | (EffortOptionBase & {
      readonly controlSource: "prompt-prefix";
      readonly apiEffortValue?: never;
    });

export type ContextWindowOption = {
  readonly value: string;
  readonly label: string;
  readonly isDefault?: true;
};

export type ModelCapabilities = {
  readonly optionDescriptors?: readonly ProviderOptionDescriptor[];
  readonly reasoningEffortLevels: readonly EffortOption[];
  readonly supportsFastMode: boolean;
  readonly supportsThinkingToggle: boolean;
  readonly promptInjectedEffortLevels: readonly string[];
  readonly contextWindowOptions: readonly ContextWindowOption[];
  readonly autoCompactWindowOptions?: readonly ContextWindowOption[];
  readonly contextWindowTokens?: number;
  readonly variantOptions?: readonly EffortOption[];
  readonly agentOptions?: readonly EffortOption[];
};

const CODEX_GPT_5_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High", isDefault: true },
    { value: "xhigh", label: "Extra High" },
  ],
  supportsFastMode: true,
  supportsThinkingToggle: false,
  promptInjectedEffortLevels: [],
  contextWindowOptions: [],
};

const CODEX_GPT_5_5_CAPABILITIES: ModelCapabilities = {
  ...CODEX_GPT_5_CAPABILITIES,
  reasoningEffortLevels: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium", isDefault: true },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra High" },
  ],
};

// Shared Claude building blocks. Capability shapes repeat across Claude
// generations, so declare them once and let each model entry override only the
// fields that genuinely differ (mirrors the CODEX_GPT_5_* pattern above).
const CLAUDE_AUTO_COMPACT_WINDOWS: readonly ContextWindowOption[] = [
  { value: "200k", label: "200k", isDefault: true },
  { value: "1m", label: "1M (model default)" },
];

function claudeApiEffortOption(
  value: ClaudeApiEffort,
  label: string,
  options: Pick<EffortOption, "isDefault"> = {},
): EffortOption {
  return { value, label, controlSource: "api-effort", ...options };
}

function claudePromptModeOption(value: ClaudePromptMode, label: string): EffortOption {
  return { value, label, controlSource: "prompt-prefix" };
}

function claudeCodeModeOption(
  value: ClaudeCodeMode,
  label: string,
  apiEffortValue: ClaudeApiEffort,
  description: string,
): EffortOption {
  return { value, label, description, apiEffortValue, controlSource: "provider-setting" };
}

// No-fast xhigh ladder: newer Claude Code models with xhigh/max API efforts and
// the ultracode mode setting, but no ultrathink prompt mode or fast mode.
const CLAUDE_NO_FAST_XHIGH_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [
    claudeApiEffortOption("low", "Low"),
    claudeApiEffortOption("medium", "Medium"),
    claudeApiEffortOption("high", "High", { isDefault: true }),
    claudeApiEffortOption("xhigh", "Extra High"),
    claudeApiEffortOption("max", "Max"),
    claudeCodeModeOption("ultracode", "Ultracode", "xhigh", "xhigh + workflows"),
  ],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  promptInjectedEffortLevels: [],
  contextWindowOptions: [],
  autoCompactWindowOptions: CLAUDE_AUTO_COMPACT_WINDOWS,
  contextWindowTokens: 1_000_000,
};

const CLAUDE_FABLE_CAPABILITIES: ModelCapabilities = CLAUDE_NO_FAST_XHIGH_CAPABILITIES;

// Opus 5 keeps the Claude 5 ladder (thinking is adaptive, so no ultrathink prompt
// mode) but stays on the Opus fast-mode lane that Fable and Sonnet lack.
const CLAUDE_OPUS_5_CAPABILITIES: ModelCapabilities = {
  ...CLAUDE_NO_FAST_XHIGH_CAPABILITIES,
  supportsFastMode: true,
};

// Full reasoning ladder: xhigh + ultracode + ultrathink (Opus 4.7/4.8).
const CLAUDE_FLAGSHIP_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [
    claudeApiEffortOption("low", "Low"),
    claudeApiEffortOption("medium", "Medium"),
    claudeApiEffortOption("high", "High", { isDefault: true }),
    claudeApiEffortOption("xhigh", "Extra High"),
    claudeApiEffortOption("max", "Max"),
    claudePromptModeOption("ultrathink", "Ultrathink"),
    claudeCodeModeOption("ultracode", "Ultracode", "xhigh", "xhigh + workflows"),
  ],
  supportsFastMode: true,
  supportsThinkingToggle: false,
  promptInjectedEffortLevels: ["ultrathink"],
  contextWindowOptions: [],
  autoCompactWindowOptions: CLAUDE_AUTO_COMPACT_WINDOWS,
  contextWindowTokens: 1_000_000,
};

// Reasoning ladder before xhigh/ultracode landed (Opus 4.6, Sonnet 4.6).
const CLAUDE_EXTENDED_THINKING_CAPABILITIES: ModelCapabilities = {
  ...CLAUDE_FLAGSHIP_CAPABILITIES,
  reasoningEffortLevels: [
    claudeApiEffortOption("low", "Low"),
    claudeApiEffortOption("medium", "Medium"),
    claudeApiEffortOption("high", "High", { isDefault: true }),
    claudeApiEffortOption("max", "Max"),
    claudePromptModeOption("ultrathink", "Ultrathink"),
  ],
};

// Sonnet 5 adds xhigh for long agentic work, while staying in the Sonnet no-fast-mode lane.
const CLAUDE_SONNET_5_CAPABILITIES: ModelCapabilities = CLAUDE_NO_FAST_XHIGH_CAPABILITIES;

type ModelDefinition = {
  readonly slug: string;
  readonly name: string;
  readonly capabilities: ModelCapabilities;
};

export const MODEL_OPTIONS_BY_PROVIDER = {
  codex: [
    {
      slug: "gpt-5.5",
      name: "GPT-5.5",
      capabilities: CODEX_GPT_5_5_CAPABILITIES,
    },
    {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      capabilities: CODEX_GPT_5_CAPABILITIES,
    },
    {
      slug: "gpt-5.4-mini",
      name: "GPT-5.4 Mini",
      capabilities: CODEX_GPT_5_CAPABILITIES,
    },
    {
      slug: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      capabilities: CODEX_GPT_5_CAPABILITIES,
    },
    {
      slug: "gpt-5.3-codex-spark",
      name: "GPT-5.3 Codex Spark",
      capabilities: CODEX_GPT_5_CAPABILITIES,
    },
    {
      slug: "gpt-5.2-codex",
      name: "GPT-5.2 Codex",
      capabilities: CODEX_GPT_5_CAPABILITIES,
    },
    {
      slug: "gpt-5.2",
      name: "GPT-5.2",
      capabilities: CODEX_GPT_5_CAPABILITIES,
    },
  ],
  claudeAgent: [
    {
      slug: "claude-fable-5",
      name: "Claude Fable 5",
      capabilities: CLAUDE_FABLE_CAPABILITIES,
    },
    {
      slug: "claude-opus-5",
      name: "Claude Opus 5",
      capabilities: CLAUDE_OPUS_5_CAPABILITIES,
    },
    {
      slug: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      capabilities: CLAUDE_FLAGSHIP_CAPABILITIES,
    },
    {
      slug: "claude-opus-4-7",
      name: "Claude Opus 4.7",
      capabilities: CLAUDE_FLAGSHIP_CAPABILITIES,
    },
    {
      slug: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      capabilities: CLAUDE_EXTENDED_THINKING_CAPABILITIES,
    },
    {
      slug: "claude-opus-4-5",
      name: "Claude Opus 4.5",
      capabilities: {
        reasoningEffortLevels: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High", isDefault: true },
        ],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
        contextWindowOptions: [],
        contextWindowTokens: 200_000,
      },
    },
    {
      slug: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      capabilities: CLAUDE_SONNET_5_CAPABILITIES,
    },
    {
      slug: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      capabilities: { ...CLAUDE_EXTENDED_THINKING_CAPABILITIES, supportsFastMode: false },
    },
    {
      slug: "claude-haiku-4-5-20251001",
      name: "Claude Haiku 4.5",
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: true,
        promptInjectedEffortLevels: [],
        contextWindowOptions: [],
        contextWindowTokens: 200_000,
      },
    },
  ],
  opencode: [
    {
      slug: "openai/gpt-5",
      name: "OpenAI GPT-5",
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        promptInjectedEffortLevels: [],
        contextWindowOptions: [],
      },
    },
  ],
} as const satisfies Record<ProviderKind, readonly ModelDefinition[]>;

export type ModelOptionsByProvider = typeof MODEL_OPTIONS_BY_PROVIDER;

type BuiltInModelSlug = (typeof MODEL_OPTIONS_BY_PROVIDER)[ProviderKind][number]["slug"];
export type ModelSlug = BuiltInModelSlug | (string & {});

export type ProviderWithDefaultModel = ProviderKind;

export const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderWithDefaultModel, ModelSlug> = {
  codex: "gpt-5.5",
  claudeAgent: "claude-sonnet-5",
  opencode: "openai/gpt-5",
};

// Backward compatibility for existing Codex-only call sites.
export const MODEL_OPTIONS = MODEL_OPTIONS_BY_PROVIDER.codex;
export const DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER.codex;
export const DEFAULT_TEXT_GENERATION_MODEL = "gpt-5.4-mini" as const;

export const MODEL_SLUG_ALIASES_BY_PROVIDER: Record<ProviderKind, Record<string, ModelSlug>> = {
  codex: {
    "5.5": "gpt-5.5",
    "5.4": "gpt-5.4",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
  },
  // Claude Code's live catalog supplies the exact native model identity. Persist
  // it unchanged: a selector alias is not a valid substitute for that identity.
  claudeAgent: {},
  opencode: {},
};

// ── Agent mention aliases ─────────────────────────────────────────────
// Re-exported from agentMentions.ts for backward compatibility
export {
  AGENT_MENTION_ALIASES,
  getAgentMentionAutocompleteAliases,
  getAgentMentionAliases,
  resolveAgentAlias,
  isValidAgentAlias,
  getAgentAliasNames,
  type AgentAliasDefinition,
  type ResolvedAgentAlias,
} from "./agentMentions";

// ── Model capabilities index ──────────────────────────────────────────

export const MODEL_CAPABILITIES_INDEX = Object.fromEntries(
  Object.entries(MODEL_OPTIONS_BY_PROVIDER).map(([provider, models]) => [
    provider,
    Object.fromEntries(models.map((m) => [m.slug, m.capabilities])),
  ]),
) as unknown as Record<ProviderKind, Record<string, ModelCapabilities>>;

// ── Provider display names ────────────────────────────────────────────

export const PROVIDER_DISPLAY_NAMES: Record<ProviderKind, string> = {
  codex: "ChatGPT",
  claudeAgent: "Claude",
  opencode: "OpenCode",
};
