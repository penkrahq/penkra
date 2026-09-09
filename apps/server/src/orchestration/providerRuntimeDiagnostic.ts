import type { ProviderKind } from "@penkra/contracts";

const MAX_DIAGNOSTIC_CODE_CHARS = 160;
const MAX_ADDITIONAL_DETAILS_CHARS = 500;

export interface CanonicalProviderRuntimeDiagnostic {
  readonly code?: string;
  readonly codeSource?: "error.codexErrorInfo";
  readonly additionalDetails?: string;
  readonly additionalDetailsTruncated?: true;
  readonly willRetry?: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= maximum ? trimmed : trimmed.slice(0, maximum);
}

/**
 * Whitelists explicit provider machine diagnostics for canonical activity.
 * The source path accompanies provider-specific codes; unrecognized fields are
 * intentionally omitted instead of copying arbitrary runtime request payloads.
 */
export function normalizeProviderRuntimeDiagnostic(
  provider: ProviderKind,
  detail: unknown,
): CanonicalProviderRuntimeDiagnostic | undefined {
  const root = record(detail);
  if (!root) return undefined;
  const error = record(root.error);
  const rawCode = error?.codexErrorInfo;
  const codexCode =
    provider === "codex" &&
    typeof rawCode === "string" &&
    rawCode.trim().length > 0 &&
    rawCode.length <= MAX_DIAGNOSTIC_CODE_CHARS
      ? rawCode
      : undefined;
  const additionalDetails =
    provider === "codex"
      ? boundedString(error?.additionalDetails, MAX_ADDITIONAL_DETAILS_CHARS)
      : undefined;
  const willRetry = typeof root.willRetry === "boolean" ? root.willRetry : undefined;
  if (codexCode === undefined && additionalDetails === undefined && willRetry === undefined) {
    return undefined;
  }
  return {
    ...(codexCode ? { code: codexCode, codeSource: "error.codexErrorInfo" as const } : {}),
    ...(additionalDetails ? { additionalDetails } : {}),
    ...(additionalDetails !== undefined &&
    typeof error?.additionalDetails === "string" &&
    error.additionalDetails.trim().length > MAX_ADDITIONAL_DETAILS_CHARS
      ? { additionalDetailsTruncated: true as const }
      : {}),
    ...(willRetry !== undefined ? { willRetry } : {}),
  };
}
