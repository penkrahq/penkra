import type {
  ModelUsage,
  NonNullableUsage,
  SDKControlGetContextUsageResponse,
} from "@anthropic-ai/claude-agent-sdk";
import type { ThreadTokenUsageSnapshot } from "@penkra/contracts";
import { getModelCapabilities } from "@penkra/shared/model";

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
  _lastKnownAutoCompactThreshold: number | undefined,
  _currentAutoCompactWindow: number | undefined,
  lastKnownContextWindow: number | undefined,
): number | undefined {
  return lastKnownContextWindow;
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
  if (/\[1m\]$/iu.test(apiModelId)) return 1_000_000;
  return positiveFiniteNumber(
    getModelCapabilities("claudeAgent", stripClaudeContextWindowSuffix(apiModelId))
      .contextWindowTokens,
  );
}

export function resolveSelectedClaudeAutoCompactWindow(
  _model: string | null | undefined,
  _selectedAutoCompactWindow: string | null | undefined,
): number | undefined {
  // Legacy draft selections must not impose a smaller window on a new turn.
  return undefined;
}

export function resolveEffectiveClaudeContextWindow(input: {
  readonly reportedContextWindow: number | undefined;
  readonly lastKnownContextWindow: number | undefined;
}): number | undefined {
  const { reportedContextWindow, lastKnownContextWindow } = input;
  return reportedContextWindow ?? lastKnownContextWindow;
}

export function snapshotFromClaudeContextUsage(
  usage: SDKControlGetContextUsageResponse,
  totalProcessedTokens?: number,
): ThreadTokenUsageSnapshot {
  const effectiveMaxTokens =
    positiveFiniteNumber(usage.rawMaxTokens) ??
    positiveFiniteNumber(usage.maxTokens);
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
