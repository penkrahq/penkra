/**
 * Public contracts for the Penkra agent-control gateway.
 *
 * New gateway tools decode these schemas before doing any work. Keeping the
 * limits here ensures the MCP surface, server implementation, and tests share
 * the same definition of an exact creation/wait plan.
 */
import { Schema } from "effect";

import { FolderId, MessageId, ThreadId, TurnId } from "./baseSchemas";
import { ModelSelection, ProviderKind } from "./orchestration";
import { ProviderModelDescriptor } from "./providerDiscovery";
import { ServerProviderAuthStatus } from "./server";

export const PENKRA_GATEWAY_MAX_THREADS_PER_OPERATION = 20;
export const PENKRA_GATEWAY_MAX_REQUEST_ID_LENGTH = 256;

export const PenkraGatewayErrorCode = Schema.Literals([
  "caller_session_inactive",
  "caller_turn_inactive",
  "capability_denied",
  "provider_unavailable",
  "model_unavailable",
  "model_option_unavailable",
  "creation_limit_exceeded",
  "thread_not_found",
  "operation_failed",
]);
export type PenkraGatewayErrorCode = typeof PenkraGatewayErrorCode.Type;

export const PenkraGatewayError = Schema.Struct({
  code: PenkraGatewayErrorCode,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
});
export type PenkraGatewayError = typeof PenkraGatewayError.Type;

export const PenkraGatewayErrorResult = Schema.Struct({
  error: PenkraGatewayError,
});
export type PenkraGatewayErrorResult = typeof PenkraGatewayErrorResult.Type;

export const PenkraContextResult = Schema.Struct({
  harness: Schema.Struct({
    name: Schema.Literal("Penkra"),
    policyVersion: Schema.String,
  }),
  caller: Schema.Struct({
    threadId: ThreadId,
    turnId: Schema.NullOr(TurnId),
    provider: ProviderKind,
    folderId: FolderId,
  }),
  capabilities: Schema.Struct({
    threadRead: Schema.Boolean,
    threadCreate: Schema.Boolean,
    diagnostics: Schema.Boolean,
  }),
});
export type PenkraContextResult = typeof PenkraContextResult.Type;

export const PenkraCreateThreadSpec = Schema.Struct({
  prompt: Schema.String.check(Schema.isNonEmpty()),
  title: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  target: ModelSelection,
  folderId: Schema.optional(FolderId),
  runtimeMode: Schema.optional(Schema.Literals(["approval-required", "full-access"])),
});
export type PenkraCreateThreadSpec = typeof PenkraCreateThreadSpec.Type;

const PenkraGatewayRequestId = Schema.String.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(PENKRA_GATEWAY_MAX_REQUEST_ID_LENGTH),
);

export const PenkraCreateThreadInput = Schema.Struct({
  requestId: PenkraGatewayRequestId,
  ...PenkraCreateThreadSpec.fields,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type PenkraCreateThreadInput = typeof PenkraCreateThreadInput.Type;

export const PenkraProviderCatalog = Schema.Struct({
  provider: ProviderKind,
  defaultModel: Schema.NullOr(Schema.String),
  models: Schema.Array(ProviderModelDescriptor),
  enabled: Schema.Boolean,
  available: Schema.Boolean,
  authStatus: Schema.optional(ServerProviderAuthStatus),
  source: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type PenkraProviderCatalog = typeof PenkraProviderCatalog.Type;

export const PenkraGatewayTargetOptionValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
]);
export type PenkraGatewayTargetOptionValue = typeof PenkraGatewayTargetOptionValue.Type;

export const PenkraGatewayTargetOptionRule = Schema.Struct({
  key: Schema.String,
  valueType: Schema.Literals(["string", "number", "boolean"]),
  allowedValues: Schema.Array(PenkraGatewayTargetOptionValue),
  allowedValuesSource: Schema.Literals(["provider-contract", "model-discovery"]),
});
export type PenkraGatewayTargetOptionRule = typeof PenkraGatewayTargetOptionRule.Type;

export const PenkraGatewayTargetConstruction = Schema.Struct({
  modelValueSource: Schema.Literal("providers[].models[].slug"),
  primaryOptionKey: Schema.String,
  alternativeOptionKeys: Schema.Array(Schema.String),
  optionSelectionRule: Schema.String,
  providerOptions: Schema.Array(PenkraGatewayTargetOptionRule),
  optionsByModel: Schema.Record(Schema.String, Schema.Array(PenkraGatewayTargetOptionRule)),
  exampleTarget: Schema.NullOr(ModelSelection),
});
export type PenkraGatewayTargetConstruction = typeof PenkraGatewayTargetConstruction.Type;

export const PenkraCapabilitiesResult = Schema.Struct({
  targetConstruction: Schema.Record(Schema.String, PenkraGatewayTargetConstruction),
  providers: Schema.Array(PenkraProviderCatalog),
});
export type PenkraCapabilitiesResult = typeof PenkraCapabilitiesResult.Type;

export const PenkraCreatedThreadResult = Schema.Struct({
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  threadId: ThreadId,
  folderId: FolderId,
  title: Schema.String,
  target: ModelSelection,
  provider: ProviderKind,
  model: Schema.String,
  runtimeMode: Schema.Literals(["approval-required", "full-access"]),
  messageId: MessageId,
  turnId: TurnId,
});
export type PenkraCreatedThreadResult = typeof PenkraCreatedThreadResult.Type;

export const PenkraCreateThreadResult = Schema.Struct({
  operationId: Schema.String,
  requestId: PenkraGatewayRequestId,
  threadId: ThreadId,
  folderId: FolderId,
  title: Schema.String,
  target: ModelSelection,
  provider: ProviderKind,
  model: Schema.String,
  runtimeMode: Schema.Literals(["approval-required", "full-access"]),
  messageId: MessageId,
  turnId: TurnId,
});
export type PenkraCreateThreadResult = typeof PenkraCreateThreadResult.Type;
