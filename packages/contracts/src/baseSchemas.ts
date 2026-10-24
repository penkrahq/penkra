import { Schema } from "effect";

export const TrimmedString = Schema.Trim;
export const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

// Shared schema for child-process environment overrides (terminals, dev servers).
// Keys follow POSIX env-name rules; values and total size are capped to keep
// requests bounded. Extracted here so terminal and project contracts stay in sync.
const ProcessEnvKey = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)).check(
  Schema.isMaxLength(128),
);
const ProcessEnvValue = Schema.String.check(Schema.isMaxLength(8_192));
export const ProcessEnvRecord = Schema.Record(ProcessEnvKey, ProcessEnvValue).check(
  Schema.isMaxProperties(128),
);
export type ProcessEnvRecord = typeof ProcessEnvRecord.Type;

export const IsoDateTime = Schema.String;
export type IsoDateTime = typeof IsoDateTime.Type;

/**
 * Construct a branded identifier. Enforces non-empty trimmed strings
 */
export const ThreadId = TrimmedNonEmptyString.pipe(Schema.brand("ThreadId"));
export type ThreadId = typeof ThreadId.Type;
export const FolderId = TrimmedNonEmptyString.pipe(Schema.brand("FolderId"));
export type FolderId = typeof FolderId.Type;
export const SpaceId = TrimmedNonEmptyString.pipe(Schema.brand("SpaceId"));
export type SpaceId = typeof SpaceId.Type;
export const ProviderInstallationId = TrimmedNonEmptyString.pipe(
  Schema.brand("ProviderInstallationId"),
);
export type ProviderInstallationId = typeof ProviderInstallationId.Type;
export const ProviderConnectionId = TrimmedNonEmptyString.pipe(
  Schema.brand("ProviderConnectionId"),
);
export type ProviderConnectionId = typeof ProviderConnectionId.Type;
export const EnvironmentId = TrimmedNonEmptyString.pipe(Schema.brand("EnvironmentId"));
export type EnvironmentId = typeof EnvironmentId.Type;
export const AuthSessionId = TrimmedNonEmptyString.pipe(Schema.brand("AuthSessionId"));
export type AuthSessionId = typeof AuthSessionId.Type;
export const CommandId = TrimmedNonEmptyString.pipe(Schema.brand("CommandId"));
export type CommandId = typeof CommandId.Type;
export const EventId = TrimmedNonEmptyString.pipe(Schema.brand("EventId"));
export type EventId = typeof EventId.Type;
export const MessageId = TrimmedNonEmptyString.pipe(Schema.brand("MessageId"));
export type MessageId = typeof MessageId.Type;
export const TurnId = TrimmedNonEmptyString.pipe(Schema.brand("TurnId"));
export type TurnId = typeof TurnId.Type;

export const ProviderItemId = TrimmedNonEmptyString.pipe(Schema.brand("ProviderItemId"));
export type ProviderItemId = typeof ProviderItemId.Type;
export const RuntimeSessionId = TrimmedNonEmptyString.pipe(Schema.brand("RuntimeSessionId"));
export type RuntimeSessionId = typeof RuntimeSessionId.Type;
export const RuntimeItemId = TrimmedNonEmptyString.pipe(Schema.brand("RuntimeItemId"));
export type RuntimeItemId = typeof RuntimeItemId.Type;
export const RuntimeRequestId = TrimmedNonEmptyString.pipe(Schema.brand("RuntimeRequestId"));
export type RuntimeRequestId = typeof RuntimeRequestId.Type;
export const RuntimeTaskId = TrimmedNonEmptyString.pipe(Schema.brand("RuntimeTaskId"));
export type RuntimeTaskId = typeof RuntimeTaskId.Type;
