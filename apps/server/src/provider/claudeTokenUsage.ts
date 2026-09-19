import type {
  ModelUsage,
  NonNullableUsage,
  SDKControlGetContextUsageResponse,
} from "@anthropic-ai/claude-agent-sdk";
import type { ThreadTokenUsageSnapshot } from "@penkra/contracts";
import { getModelCapabilities, trimOrNull } from "@penkra/shared/model";

import { positiveFiniteNumber } from "./tokenUsage.ts";

export const CLAUDE_CONTEXT_WINDOW_MAX_TOKENS = {
  "200k": 200_000,
  "1m": 1_000_000,
} as const;

export function maxClaudeContextWindowFromModelUsage(
  modelUsage: Record<string, ModelUsage> | undefined,
): number | undefined {
  if (!modelUsage) return undefined;

  let maxContextWindow: number | undefined;
  for (const value of Object.values(modelUsage)) {
    const contextWindow = positiveFiniteNumber(value.contextWindow);
    if (contextWindow === undefined) {
      continue;
    }
    maxContextWindow = Math.max(maxContextWindow ?? 0, contextWindow);
  }

  return maxContextWindow;
}

function finiteClaudeTokenCountOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function claudePromptTokensFromRawUsage(usage: Record<string, unknown>): number {
  return (
    finiteClaudeTokenCountOrZero(usage.input_tokens) +
    finiteClaudeTokenCountOrZero(usage.cache_creation_input_tokens) +
    finiteClaudeTokenCountOrZero(usage.cache_read_input_tokens)
  );
}

export function resolveClaudeEffectiveContextBudget(
  lastKnownAutoCompactThreshold: number | undefined,
  currentAutoCompactWindow: number | undefined,
  lastKnownContextWindow: number | undefined,
): number | undefined {
  const autoCompactBudget = lastKnownAutoCompactThreshold ?? currentAutoCompactWindow;
  if (autoCompactBudget !== undefined && lastKnownContextWindow !== undefined) {
    return Math.min(autoCompactBudget, lastKnownContextWindow);
  }
  return autoCompactBudget ?? lastKnownContextWindow;
}

export function stripClaudeContextWindowSuffix(apiModelId: string): string {
  return apiModelId.replace(/\[[^\]]+\]$/u, "");
}

export function normalizeClaudeTokenUsage(
  value: NonNullableUsage | Record<string, unknown> | undefined,
  contextWindow?: number,
): ThreadTokenUsageSnapshot | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const inputTokens = claudePromptTokensFromRawUsage(usage);
  const outputTokens = finiteClaudeTokenCountOrZero(usage.output_tokens);
  const derivedTotalProcessedTokens = inputTokens + outputTokens;
  const totalProcessedTokens =
    (typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens)
      ? usage.total_tokens
      : undefined) ?? (derivedTotalProcessedTokens > 0 ? derivedTotalProcessedTokens : undefined);
  if (totalProcessedTokens === undefined || totalProcessedTokens <= 0) {
    return undefined;
  }

  const maxTokens = positiveFiniteNumber(contextWindow);
  const usedTokens =
    maxTokens !== undefined ? Math.min(totalProcessedTokens, maxTokens) : totalProcessedTokens;

  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(totalProcessedTokens > usedTokens ? { totalProcessedTokens } : {}),
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(typeof usage.tool_uses === "number" && Number.isFinite(usage.tool_uses)
      ? { toolUses: usage.tool_uses }
      : {}),
    ...(typeof usage.duration_ms === "number" && Number.isFinite(usage.duration_ms)
      ? { durationMs: usage.duration_ms }
      : {}),
  };
}

export function mergeClaudeTokenUsageSnapshot(
  previous: ThreadTokenUsageSnapshot,
  accumulated: ThreadTokenUsageSnapshot | undefined,
  contextWindow?: number,
): ThreadTokenUsageSnapshot {
  const maxTokens = positiveFiniteNumber(contextWindow);
  const usedTokens =
    maxTokens !== undefined ? Math.min(previous.usedTokens, maxTokens) : previous.usedTokens;
  const lastUsedTokens =
    previous.lastUsedTokens !== undefined
      ? maxTokens !== undefined
        ? Math.min(previous.lastUsedTokens, maxTokens)
        : previous.lastUsedTokens
      : usedTokens;
  const totalProcessedTokens = Math.max(
    previous.totalProcessedTokens ?? previous.usedTokens,
    accumulated?.totalProcessedTokens ?? accumulated?.usedTokens ?? 0,
    usedTokens,
  );

  return {
    ...previous,
    usedTokens,
    lastUsedTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(totalProcessedTokens > usedTokens ? { totalProcessedTokens } : {}),
  };
}

export function resolveClaudeApiModelIdContextWindowMaxTokens(
  apiModelId: string | undefined,
): number | undefined {
  if (!apiModelId) {
    return undefined;
  }
  return positiveFiniteNumber(
    getModelCapabilities("claudeAgent", stripClaudeContextWindowSuffix(apiModelId))
      .contextWindowTokens,
  );
}

export function resolveSelectedClaudeAutoCompactWindow(
  _model: string | null | undefined,
  selectedAutoCompactWindow: string | null | undefined,
): number | undefined {
  const resolvedAutoCompactWindow = trimOrNull(selectedAutoCompactWindow) ?? "200k";
  if (
    !Object.prototype.hasOwnProperty.call(
      CLAUDE_CONTEXT_WINDOW_MAX_TOKENS,
      resolvedAutoCompactWindow,
    )
  ) {
    return undefined;
  }

  return CLAUDE_CONTEXT_WINDOW_MAX_TOKENS[
    resolvedAutoCompactWindow as keyof typeof CLAUDE_CONTEXT_WINDOW_MAX_TOKENS
  ];
}

export function resolveEffectiveClaudeContextWindow(input: {
  readonly reportedContextWindow: number | undefined;
  readonly lastKnownContextWindow: number | undefined;
}): number | undefined {
  const { reportedContextWindow, lastKnownContextWindow } = input;
  if (reportedContextWindow !== undefined && lastKnownContextWindow !== undefined) {
    // Some SDK result payloads still report the historical 200k window for
    // native-1M models. Never downgrade a known model capacity from that field.
    return Math.max(reportedContextWindow, lastKnownContextWindow);
  }
  return reportedContextWindow ?? lastKnownContextWindow;
}

export function snapshotFromClaudeContextUsage(
  usage: SDKControlGetContextUsageResponse,
  totalProcessedTokens?: number,
): ThreadTokenUsageSnapshot {
  const effectiveMaxTokens =
    positiveFiniteNumber(usage.autoCompactThreshold) ??
    positiveFiniteNumber(usage.maxTokens) ??
    positiveFiniteNumber(usage.rawMaxTokens);
  const usedTokens = Math.max(0, Math.round(usage.totalTokens));
  const rawApiUsage = usage.apiUsage as Record<string, unknown> | undefined;
  const inputTokens = Math.max(
    0,
    Math.round(rawApiUsage ? claudePromptTokensFromRawUsage(rawApiUsage) : 0),
  );
  const cachedInputTokens = Math.max(
    0,
    Math.round(finiteClaudeTokenCountOrZero(rawApiUsage?.cache_read_input_tokens)),
  );
  const outputTokens = Math.max(
    0,
    Math.round(finiteClaudeTokenCountOrZero(rawApiUsage?.output_tokens)),
  );
  return {
    usedTokens:
      effectiveMaxTokens !== undefined ? Math.min(usedTokens, effectiveMaxTokens) : usedTokens,
    lastUsedTokens: usedTokens,
    ...(effectiveMaxTokens !== undefined
      ? {
          maxTokens: effectiveMaxTokens,
          usedPercent: Math.min(100, (usedTokens / effectiveMaxTokens) * 100),
        }
      : {}),
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(inputTokens > 0 ? { inputTokens, lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens > 0
      ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens }
      : {}),
    ...(outputTokens > 0 ? { outputTokens, lastOutputTokens: outputTokens } : {}),
    compactsAutomatically: usage.isAutoCompactEnabled,
  };
}
