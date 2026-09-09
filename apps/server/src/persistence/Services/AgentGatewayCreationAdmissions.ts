import { Effect, Option, Schema, ServiceMap } from "effect";
import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "@penkra/contracts";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

export const AgentGatewayCreationAdmission = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  callerThreadId: TrimmedNonEmptyString,
  callerTurnId: TrimmedNonEmptyString,
  requestId: TrimmedNonEmptyString,
  requestFingerprintVersion: PositiveInt,
  requestFingerprint: Digest,
  planSchemaVersion: PositiveInt,
  threadCreateCommandJson: Schema.String,
  turnStartCommandJson: Schema.String,
  recapCommandJson: Schema.String,
  cwd: Schema.String,
  resultJson: Schema.String,
  admittedAt: IsoDateTime,
});
export type AgentGatewayCreationAdmission = typeof AgentGatewayCreationAdmission.Type;

export type ReserveAgentGatewayCreationAdmissionResult =
  | { readonly kind: "reserved"; readonly admission: AgentGatewayCreationAdmission }
  | { readonly kind: "existing"; readonly admission: AgentGatewayCreationAdmission };

type RepositoryError = PersistenceSqlError | PersistenceDecodeError;

export interface AgentGatewayCreationAdmissionRepositoryShape {
  readonly reserve: (
    admission: AgentGatewayCreationAdmission,
  ) => Effect.Effect<ReserveAgentGatewayCreationAdmissionResult, RepositoryError>;
  readonly get: (
    operationId: string,
  ) => Effect.Effect<Option.Option<AgentGatewayCreationAdmission>, RepositoryError>;
}

export class AgentGatewayCreationAdmissionRepository extends ServiceMap.Service<
  AgentGatewayCreationAdmissionRepository,
  AgentGatewayCreationAdmissionRepositoryShape
>()("penkra/persistence/Services/AgentGatewayCreationAdmissions/Repository") {}
