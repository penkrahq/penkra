// FILE: ProviderInstallations.ts
// Purpose: Durable registry for immutable, verified managed provider generations.

import {
  IsoDateTime,
  ProviderInstallation,
  ProviderInstallationId,
  ProviderKind,
  TrimmedNonEmptyString,
} from "@penkra/contracts";
import { Effect, Option, Schema, ServiceMap } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export type ProviderInstallationRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export const ActivateProviderInstallationInput = Schema.Struct({
  id: ProviderInstallationId,
  harness: ProviderKind,
  version: TrimmedNonEmptyString,
  platform: TrimmedNonEmptyString,
  architecture: TrimmedNonEmptyString,
  executablePath: TrimmedNonEmptyString,
  artifactSource: TrimmedNonEmptyString,
  artifactUrl: TrimmedNonEmptyString,
  artifactSha256: TrimmedNonEmptyString,
  adapterVersion: TrimmedNonEmptyString,
  protocolVersion: TrimmedNonEmptyString,
  installedAt: IsoDateTime,
  activatedAt: IsoDateTime,
});
export type ActivateProviderInstallationInput = typeof ActivateProviderInstallationInput.Type;

export const ProviderInstallationRecord = Schema.Struct({
  ...ProviderInstallation.fields,
  executablePath: TrimmedNonEmptyString,
  artifactSource: TrimmedNonEmptyString,
  artifactUrl: TrimmedNonEmptyString,
  artifactSha256: TrimmedNonEmptyString,
});
export type ProviderInstallationRecord = typeof ProviderInstallationRecord.Type;

export interface ProviderInstallationRepositoryShape {
  readonly activate: (
    input: ActivateProviderInstallationInput,
  ) => Effect.Effect<ProviderInstallation, ProviderInstallationRepositoryError>;
  readonly list: () => Effect.Effect<
    ReadonlyArray<ProviderInstallation>,
    ProviderInstallationRepositoryError
  >;
  readonly getRecord: (
    id: ProviderInstallationId,
  ) => Effect.Effect<
    Option.Option<ProviderInstallationRecord>,
    ProviderInstallationRepositoryError
  >;
  readonly reactivate: (
    id: ProviderInstallationId,
    activatedAt: typeof IsoDateTime.Type,
  ) => Effect.Effect<ProviderInstallation, ProviderInstallationRepositoryError>;
}

export class ProviderInstallationRepository extends ServiceMap.Service<
  ProviderInstallationRepository,
  ProviderInstallationRepositoryShape
>()("penkra/persistence/Services/ProviderInstallations/ProviderInstallationRepository") {}
