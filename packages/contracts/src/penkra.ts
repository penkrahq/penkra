import { Schema } from "effect";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

export const PenkraConnectionStatus = Schema.Literals([
  "disabled",
  "needs-hq-auth",
  "offline",
  "ready",
]);
export type PenkraConnectionStatus = typeof PenkraConnectionStatus.Type;

export const PenkraClientStatus = Schema.Literals(["active", "suspended", "archived"]);
export type PenkraClientStatus = typeof PenkraClientStatus.Type;

export const PenkraTodoStatus = Schema.Literals([
  "open",
  "doing",
  "blocked",
  "with_partner",
  "done",
  "cancelled",
]);
export type PenkraTodoStatus = typeof PenkraTodoStatus.Type;

export const PenkraExecution = Schema.Literals(["agent", "human"]);
export type PenkraExecution = typeof PenkraExecution.Type;

export const PenkraBadge = Schema.Struct({
  count: NonNegativeInt,
  urgent: Schema.Boolean,
  blocked: Schema.Boolean,
  withPartner: Schema.Boolean,
});
export type PenkraBadge = typeof PenkraBadge.Type;

export const PenkraClientSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  status: PenkraClientStatus,
  badge: PenkraBadge,
});
export type PenkraClientSummary = typeof PenkraClientSummary.Type;

export const PenkraTodoSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  clientId: TrimmedNonEmptyString,
  programId: Schema.NullOr(TrimmedNonEmptyString),
  source: Schema.Literals(["operator", "agent", "system", "client"]),
  kind: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  status: PenkraTodoStatus,
  execution: PenkraExecution,
  dueAt: Schema.NullOr(Schema.String),
  payload: Schema.Record(Schema.String, Schema.Unknown),
  blockedReason: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  auto: Schema.Boolean,
  operatorTouched: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  doneAt: Schema.NullOr(Schema.String),
  skillRef: Schema.NullOr(Schema.String),
  defaultProvider: Schema.NullOr(Schema.String),
  defaultModel: Schema.NullOr(Schema.String),
  programLabel: Schema.NullOr(Schema.String),
});
export type PenkraTodoSummary = typeof PenkraTodoSummary.Type;

export const PenkraProgramWarning = Schema.Struct({
  programId: TrimmedNonEmptyString,
  clientId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
});
export type PenkraProgramWarning = typeof PenkraProgramWarning.Type;

export const PenkraSkillSummary = Schema.Struct({
  scope: Schema.Literals(["client", "hq"]),
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
});
export type PenkraSkillSummary = typeof PenkraSkillSummary.Type;

export const PenkraSnapshot = Schema.Struct({
  status: PenkraConnectionStatus,
  generatedAt: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  clients: Schema.Array(PenkraClientSummary),
  todos: Schema.Array(PenkraTodoSummary),
  programWarnings: Schema.Array(PenkraProgramWarning),
  skills: Schema.optional(Schema.Array(PenkraSkillSummary)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
});
export type PenkraSnapshot = typeof PenkraSnapshot.Type;

const OptionalContactFields = {
  primaryPhone: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  country: Schema.optional(Schema.String),
  notes: Schema.optional(Schema.String),
} as const;

export const PenkraCreateClientInput = Schema.Struct({
  displayName: TrimmedNonEmptyString,
  ...OptionalContactFields,
  idempotencyKey: TrimmedNonEmptyString,
});
export type PenkraCreateClientInput = typeof PenkraCreateClientInput.Type;

export const PenkraCreateClientResult = Schema.Struct({
  id: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  status: PenkraClientStatus,
});
export type PenkraCreateClientResult = typeof PenkraCreateClientResult.Type;

export const PenkraCreateTodoInput = Schema.Struct({
  clientId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  kind: Schema.optional(TrimmedNonEmptyString),
  dueAt: Schema.optional(Schema.String),
  execution: Schema.optional(PenkraExecution),
  payload: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  idempotencyKey: TrimmedNonEmptyString,
});
export type PenkraCreateTodoInput = typeof PenkraCreateTodoInput.Type;

export const PenkraUpdateTodoInput = Schema.Struct({
  todoId: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
  dueAt: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(PenkraTodoStatus),
  blockedReason: Schema.optional(Schema.NullOr(Schema.String)),
  operatorTouched: Schema.optional(Schema.Boolean),
});
export type PenkraUpdateTodoInput = typeof PenkraUpdateTodoInput.Type;

export const PenkraMutationResult = Schema.Struct({
  todoId: TrimmedNonEmptyString,
});
export type PenkraMutationResult = typeof PenkraMutationResult.Type;

export const PenkraReconcileResult = Schema.Struct({
  status: Schema.Literals(["disabled", "needs-hq-auth", "reconciled"]),
  clients: NonNegativeInt,
  unknownFolders: Schema.Array(Schema.String),
  archivedClients: Schema.Array(Schema.String),
});
export type PenkraReconcileResult = typeof PenkraReconcileResult.Type;
