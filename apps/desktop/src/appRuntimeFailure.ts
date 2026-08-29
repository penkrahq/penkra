// FILE: appRuntimeFailure.ts
// Purpose: Composes trusted App lifecycle failures without traversing arbitrary error graphs.
// Layer: Trusted desktop App runtime

import type { AppRuntimeFailureDto } from "@penkra/contracts";

export type AppRuntimeFailure =
  | { kind: "leaf"; code?: string; message: string }
  | {
      kind: "operation";
      message: string;
      primary: AppRuntimeFailure;
      secondary: readonly LabeledAppRuntimeFailure[];
    }
  | { kind: "group"; message: string; failures: readonly LabeledAppRuntimeFailure[] };

export interface LabeledAppRuntimeFailure {
  role: string;
  failure: AppRuntimeFailure;
}

export class AppRuntimeFailureError extends Error {
  readonly failure: AppRuntimeFailure;
  readonly rawCause: unknown;

  constructor(failure: AppRuntimeFailure, rawCause?: unknown) {
    super(failure.message, rawCause === undefined ? undefined : { cause: rawCause });
    this.name = "AppRuntimeFailureError";
    this.failure = failure;
    this.rawCause = rawCause;
  }
}

export function appRuntimeFailure(value: unknown): AppRuntimeFailure {
  if (value instanceof AppRuntimeFailureError) return value.failure;
  const code = safelyReadString(value, "code");
  const message = safelyReadString(value, "message") ?? safelyString(value);
  return { kind: "leaf", ...(code === undefined ? {} : { code }), message };
}

export function appRuntimeOperationFailure(input: {
  message: string;
  primary: unknown;
  secondary?: ReadonlyArray<{ role: string; failure: unknown }>;
}): AppRuntimeFailure {
  return {
    kind: "operation",
    message: input.message,
    primary: appRuntimeFailure(input.primary),
    secondary: (input.secondary ?? []).map((entry) => ({
      role: entry.role,
      failure: appRuntimeFailure(entry.failure),
    })),
  };
}

export function appRuntimeGroupFailure(
  message: string,
  failures: ReadonlyArray<{ role: string; failure: unknown }>,
): AppRuntimeFailure {
  return {
    kind: "group",
    message,
    failures: failures.map((entry) => ({
      role: entry.role,
      failure: appRuntimeFailure(entry.failure),
    })),
  };
}

export function appRuntimeFailureDto(failure: AppRuntimeFailure): AppRuntimeFailureDto {
  switch (failure.kind) {
    case "leaf":
      return { ...failure };
    case "operation":
      return {
        kind: "operation",
        message: failure.message,
        primary: appRuntimeFailureDto(failure.primary),
        secondary: canonicalFailures(failure.secondary),
      };
    case "group":
      return {
        kind: "group",
        message: failure.message,
        failures: canonicalFailures(failure.failures),
      };
  }
}

function canonicalFailures(
  failures: readonly LabeledAppRuntimeFailure[],
): Array<{ role: string; failure: AppRuntimeFailureDto }> {
  return failures
    .map((entry) => ({ role: entry.role, failure: appRuntimeFailureDto(entry.failure) }))
    .toSorted((left, right) => left.role.localeCompare(right.role));
}

function safelyReadString(value: unknown, field: string): string | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  try {
    const candidate = (value as Record<string, unknown>)[field];
    return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function safelyString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[unprintable thrown value]";
  }
}
