import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderConnectionId,
  ServerProviderUsageSnapshot,
  ServerProviderUsageLimit,
} from "@penkra/contracts";
import type { GetAccountRateLimitsResponse } from "../provider/generated/codex/v2/GetAccountRateLimitsResponse.ts";
import {
  buildSnapshot,
  needsAuthSnapshot,
  unsupportedSnapshot,
  formatUsd,
  titleCase,
} from "./parse.ts";
import { snapshotFromConnectionRateLimitFact } from "./runtimeFacts.ts";

export function codexNativeUsage(input: {
  connectionId: ProviderConnectionId;
  nowMs: number;
  limits: GetAccountRateLimitsResponse | null;
}): ServerProviderUsageSnapshot {
  if (input.limits === null)
    return {
      ...needsAuthSnapshot("codex", input.nowMs, "provider-runtime"),
      connectionId: input.connectionId,
    };
  const observed = snapshotFromConnectionRateLimitFact({
    connectionId: input.connectionId,
    provider: "codex",
    limitsJson: JSON.stringify(input.limits),
    status: null,
    sourceEventId: "account/rateLimits/read",
    updatedAt: new Date(input.nowMs).toISOString(),
  });
  const credits = input.limits.rateLimits.credits;
  const balance =
    credits?.balance === null || credits?.balance === undefined
      ? undefined
      : Number(credits.balance);
  if (balance !== undefined && !Number.isFinite(balance))
    throw new Error("Codex reported an invalid native credit balance.");
  return {
    ...buildSnapshot({
      provider: "codex",
      nowMs: input.nowMs,
      source: "provider-runtime",
      status: "ok",
      limits: observed?.limits ?? [],
      ...(input.limits.rateLimits.planType
        ? { planName: titleCase(input.limits.rateLimits.planType) }
        : {}),
      usageLines: credits?.unlimited
        ? [{ label: "Credits", value: "Unlimited" }]
        : balance !== undefined && (credits?.hasCredits || balance > 0)
          ? [{ label: "Credits", value: `${formatUsd(balance)} remaining` }]
          : [],
    }),
    connectionId: input.connectionId,
  };
}

export function claudeNativeUsage(
  report: SDKControlGetUsageResponse,
  nowMs: number,
): ServerProviderUsageSnapshot {
  if (!report.rate_limits_available || report.rate_limits === null)
    return unsupportedSnapshot(
      "claudeAgent",
      nowMs,
      "provider-runtime",
      "Usage isn’t available for this Connection.",
    );
  const limits: ServerProviderUsageLimit[] = [];
  const add = (
    window: string,
    value: { utilization: number | null; resets_at: string | null } | null | undefined,
    windowDurationMins = 10_080,
  ) => {
    if (!value || (value.utilization === null && value.resets_at === null)) return;
    limits.push({
      window,
      windowDurationMins,
      ...(value.utilization === null ? {} : { usedPercent: value.utilization }),
      ...(value.resets_at === null ? {} : { resetsAt: value.resets_at }),
      observedAt: new Date(nowMs).toISOString(),
    });
  };
  add("5h", report.rate_limits.five_hour, 300);
  add("Weekly", report.rate_limits.seven_day);
  add("Weekly OAuth apps", report.rate_limits.seven_day_oauth_apps);
  add("Opus", report.rate_limits.seven_day_opus);
  add("Sonnet", report.rate_limits.seven_day_sonnet);
  for (const window of report.rate_limits.model_scoped ?? []) add(window.display_name, window);
  const extra = report.rate_limits.extra_usage;
  const money = (amount: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: extra?.currency ?? "USD",
      maximumFractionDigits: 2,
    }).format(amount / 100);
  const usageLines =
    extra?.is_enabled && extra.used_credits !== null
      ? [
          {
            label: "Extra usage",
            value:
              extra.monthly_limit !== null && extra.monthly_limit > 0
                ? `${money(extra.used_credits)} of ${money(extra.monthly_limit)}`
                : `${money(extra.used_credits)} spent`,
          },
        ]
      : [];
  return buildSnapshot({
    provider: "claudeAgent",
    nowMs,
    source: "provider-runtime",
    status: "ok",
    limits,
    usageLines,
    ...(report.subscription_type ? { planName: titleCase(report.subscription_type) } : {}),
  });
}
