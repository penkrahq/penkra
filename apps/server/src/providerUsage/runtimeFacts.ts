// FILE: runtimeFacts.ts
// Purpose: Normalize provider-native rate-limit events persisted for a managed Connection.

import type { ServerProviderUsageLimit, ServerProviderUsageSnapshot } from "@penkra/contracts";

import type { ConnectionRateLimitFactRecord } from "../persistence/Services/ConnectionUsageFacts";
import { asFiniteNumber, asRecord, clampPercent, isoFromUnixSeconds } from "./parse";

function usedPercent(value: Record<string, unknown>): number | undefined {
  const direct = asFiniteNumber(value.usedPercent);
  if (direct !== undefined) return clampPercent(direct);
  const utilization = asFiniteNumber(value.utilization);
  if (utilization === undefined) return undefined;
  return clampPercent(utilization <= 1 ? utilization * 100 : utilization);
}

function resetAt(value: unknown): string | undefined {
  if (typeof value === "number") return isoFromUnixSeconds(value);
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function labelFor(label: string, duration: number | undefined): string {
  if (duration === 300) return "5h";
  if (duration === 10_080) return "Weekly";
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/gu, "_");
  if (normalized === "session" || normalized === "five_hour" || normalized === "5h") return "5h";
  if (normalized === "weekly" || normalized === "seven_day" || normalized === "7d") {
    return "Weekly";
  }
  return label || "Current";
}

function normalizeWindow(label: string, value: unknown): ServerProviderUsageLimit | null {
  const window = asRecord(value);
  if (!window) return null;
  const percent = usedPercent(window);
  const resetsAt = resetAt(window.resetsAt);
  const duration = asFiniteNumber(window.windowDurationMins);
  if (percent === undefined && resetsAt === undefined) return null;
  return {
    window: labelFor(label, duration),
    ...(percent !== undefined ? { usedPercent: percent } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(duration !== undefined ? { windowDurationMins: duration } : {}),
  };
}

function extractLimits(value: unknown): ServerProviderUsageLimit[] {
  const root = asRecord(value);
  if (!root) return [];
  const rateLimits = asRecord(root.rateLimits);
  const nestedRateLimits = rateLimits ? (asRecord(rateLimits.rateLimits) ?? rateLimits) : root;

  if (Array.isArray(nestedRateLimits.limits)) {
    const limits = nestedRateLimits.limits.flatMap((entry) => {
      const record = asRecord(entry);
      if (!record) return [];
      const label = typeof record.window === "string" ? record.window : "Current";
      const normalized = normalizeWindow(label, record);
      return normalized ? [normalized] : [];
    });
    if (limits.length > 0) return limits;
  }

  const byId = asRecord(nestedRateLimits.rateLimitsByLimitId);
  if (byId) {
    const limits = Object.values(byId).flatMap((entry) => {
      const record = asRecord(entry);
      if (!record) return [];
      const label =
        typeof record.label === "string"
          ? record.label
          : typeof record.window === "string"
            ? record.window
            : "Current";
      const normalized = normalizeWindow(label, record.primary);
      return normalized ? [normalized] : [];
    });
    if (limits.length > 0) return limits;
  }

  const primary = normalizeWindow("Session", nestedRateLimits.primary);
  const secondary = normalizeWindow("Weekly", nestedRateLimits.secondary);
  if (primary || secondary) return [primary, secondary].filter((limit) => limit !== null);

  const claudeInfo = asRecord(nestedRateLimits.rate_limit_info);
  if (claudeInfo) {
    const rateLimitType =
      typeof claudeInfo.rateLimitType === "string" ? claudeInfo.rateLimitType : "Current";
    const duration =
      rateLimitType === "five_hour" ? 300 : rateLimitType === "seven_day" ? 10_080 : undefined;
    const normalized = normalizeWindow(rateLimitType, {
      ...claudeInfo,
      ...(duration !== undefined ? { windowDurationMins: duration } : {}),
    });
    if (normalized) return [normalized];
  }

  const fallback = normalizeWindow("Current", nestedRateLimits);
  return fallback ? [fallback] : [];
}

export function snapshotFromConnectionRateLimitFact(
  fact: ConnectionRateLimitFactRecord,
): ServerProviderUsageSnapshot | null {
  let payload: unknown;
  try {
    payload = JSON.parse(fact.limitsJson);
  } catch {
    return null;
  }
  const limits = extractLimits(payload);
  if (limits.length === 0) return null;
  return {
    provider: fact.provider,
    connectionId: fact.connectionId,
    updatedAt: fact.updatedAt,
    limits,
    usageLines: [],
    source: "provider-runtime-rate-limits",
    status: "ok",
  };
}
