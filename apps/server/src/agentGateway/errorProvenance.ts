import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  ProviderSessionDirectoryPersistenceError,
  ProviderSessionNotFoundError,
  ProviderUnsupportedError,
  ProviderValidationError,
} from "../provider/Errors.ts";
import type { ProviderKind } from "@penkra/contracts";
import { ProviderTurnSelectionResolutionError } from "../provider/Services/ProviderTurnSelectionResolver.ts";
import { ProviderThreadSwitchCoordinatorError } from "../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { sanitizeDiagnosticValue } from "./diagnosticSanitizer.ts";

const MAX_CAUSE_DEPTH = 4;
const MAX_DETAIL_CHARS = 1_000;
const MAX_METADATA_CHARS = 256;
const KNOWN_PROVIDERS: ReadonlySet<ProviderKind> = new Set(["codex", "claudeAgent", "opencode"]);

export interface GatewayErrorProvenance {
  readonly source:
    | "provider-adapter"
    | "provider-selection"
    | "provider-switch"
    | "provider-service"
    | "unknown";
  readonly errorKind: string;
  readonly provider: string | null;
  readonly operation: string | null;
  readonly operationTruncated: boolean;
  readonly method: string | null;
  readonly methodTruncated: boolean;
  readonly detail: string | null;
  readonly detailTruncated: boolean;
  readonly causeDepth: number;
  readonly causeTruncated: boolean;
}

const emptyProvenance = (causeTruncated: boolean): GatewayErrorProvenance => ({
  source: "unknown",
  errorKind: "unknown",
  provider: null,
  operation: null,
  operationTruncated: false,
  method: null,
  methodTruncated: false,
  detail: null,
  detailTruncated: false,
  causeDepth: 0,
  causeTruncated,
});

const boundedString = (value: string, maxChars: number) => {
  const sanitized = sanitizeDiagnosticValue(value);
  const text = typeof sanitized === "string" ? sanitized : "[unavailable]";
  return text.length <= maxChars
    ? { value: text, truncated: text !== value }
    : {
        value: `${text.slice(0, maxChars)}… [truncated]`,
        truncated: true,
      };
};

const typedProvenance = (input: {
  readonly source: Exclude<GatewayErrorProvenance["source"], "unknown">;
  readonly errorKind: string;
  readonly provider?: string;
  readonly operation?: string;
  readonly method?: string;
  readonly detail?: string;
}): GatewayErrorProvenance => {
  const operation = boundedString(input.operation ?? "", MAX_METADATA_CHARS);
  const method = boundedString(input.method ?? "", MAX_METADATA_CHARS);
  const detail = input.detail === undefined ? null : boundedString(input.detail, MAX_DETAIL_CHARS);
  return {
    source: input.source,
    errorKind: input.errorKind,
    provider:
      input.provider !== undefined && KNOWN_PROVIDERS.has(input.provider as ProviderKind)
        ? input.provider
        : null,
    operation: input.operation === undefined ? null : operation.value,
    operationTruncated: input.operation === undefined ? false : operation.truncated,
    method: input.method === undefined ? null : method.value,
    methodTruncated: input.method === undefined ? false : method.truncated,
    detail: detail?.value ?? null,
    detailTruncated: detail?.truncated ?? false,
    causeDepth: 0,
    causeTruncated: false,
  };
};

type KnownError = {
  readonly provenance: GatewayErrorProvenance;
  readonly cause: unknown;
};

const classify = (error: unknown): KnownError | null => {
  if (error instanceof ProviderAdapterValidationError) {
    return {
      provenance: typedProvenance({
        source: "provider-adapter",
        errorKind: "ProviderAdapterValidationError",
        provider: error.provider,
        operation: error.operation,
        detail: error.issue,
      }),
      cause: error.cause,
    };
  }
  if (error instanceof ProviderAdapterRequestError) {
    return {
      provenance: typedProvenance({
        source: "provider-adapter",
        errorKind: "ProviderAdapterRequestError",
        provider: error.provider,
        method: error.method,
        detail: error.detail,
      }),
      cause: error.cause,
    };
  }
  if (error instanceof ProviderAdapterProcessError) {
    return {
      provenance: typedProvenance({
        source: "provider-adapter",
        errorKind: "ProviderAdapterProcessError",
        provider: error.provider,
        detail: error.detail,
      }),
      cause: error.cause,
    };
  }
  if (error instanceof ProviderAdapterSessionNotFoundError) {
    return {
      provenance: typedProvenance({
        source: "provider-adapter",
        errorKind: "ProviderAdapterSessionNotFoundError",
        provider: error.provider,
      }),
      cause: error.cause,
    };
  }
  if (error instanceof ProviderAdapterSessionClosedError) {
    return {
      provenance: typedProvenance({
        source: "provider-adapter",
        errorKind: "ProviderAdapterSessionClosedError",
        provider: error.provider,
      }),
      cause: error.cause,
    };
  }
  if (error instanceof ProviderValidationError) {
    return {
      provenance: typedProvenance({
        source: "provider-service",
        errorKind: "ProviderValidationError",
        operation: error.operation,
        detail: error.issue,
      }),
      cause: error.cause,
    };
  }
  if (error instanceof ProviderUnsupportedError) {
    return {
      provenance: typedProvenance({
        source: "provider-service",
        errorKind: "ProviderUnsupportedError",
        provider: error.provider,
      }),
      cause: error.cause,
    };
  }
  if (error instanceof ProviderSessionNotFoundError) {
    return {
      provenance: typedProvenance({
        source: "provider-service",
        errorKind: "ProviderSessionNotFoundError",
      }),
      cause: error.cause,
    };
  }
  if (error instanceof ProviderSessionDirectoryPersistenceError) {
    return {
      provenance: typedProvenance({
        source: "provider-service",
        errorKind: "ProviderSessionDirectoryPersistenceError",
        operation: error.operation,
        detail: error.detail,
      }),
      cause: error.cause,
    };
  }
  if (error instanceof ProviderTurnSelectionResolutionError) {
    return {
      provenance: typedProvenance({
        source: "provider-selection",
        errorKind: "ProviderTurnSelectionResolutionError",
        detail: error.detail,
      }),
      cause: error.cause,
    };
  }
  if (error instanceof ProviderThreadSwitchCoordinatorError) {
    return {
      provenance: typedProvenance({
        source: "provider-switch",
        errorKind: "ProviderThreadSwitchCoordinatorError",
        detail: error.detail,
      }),
      cause: error.cause,
    };
  }
  return null;
};

const walk = (error: unknown, depth: number, seen: Set<object>): GatewayErrorProvenance => {
  const known = classify(error);
  if (known === null) return emptyProvenance(depth > 0);
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return { ...known.provenance, causeTruncated: true };
  }
  seen.add(error);
  if (known.cause === undefined) return known.provenance;
  if (depth >= MAX_CAUSE_DEPTH) return { ...known.provenance, causeTruncated: true };
  const nested = walk(known.cause, depth + 1, seen);
  if (nested.errorKind === "unknown") return { ...known.provenance, causeTruncated: true };
  return { ...nested, causeDepth: nested.causeDepth + 1 };
};

/** Extract only allow-listed provider fields; unknown cause objects are never enumerated. */
export function extractGatewayErrorProvenance(error: unknown): GatewayErrorProvenance {
  return walk(error, 0, new Set<object>());
}
