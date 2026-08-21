// FILE: providerConnectionCapabilities.ts
// Purpose: Exact, server-declared model-route authorization for composer Connections.

import type {
  ProviderConnectionId,
  ProviderConnectionsSnapshot,
  ProviderKind,
} from "@penkra/contracts";

export function modelInternalProviderId(provider: ProviderKind, model: string): string | null {
  return provider === "opencode" ? (model.split("/", 1)[0] ?? null) : null;
}

export function isManagedHarnessConfigured(input: {
  snapshot: ProviderConnectionsSnapshot;
  provider: ProviderKind;
}): boolean {
  const hasActiveInstallation = input.snapshot.installations.some(
    (installation) =>
      installation.harness === input.provider && installation.lifecycle === "active",
  );
  if (!hasActiveInstallation) return false;
  return (
    input.snapshot.connections.some(
      (connection) => connection.harness === input.provider && connection.lifecycle === "active",
    ) || input.snapshot.anonymousRoutes.some((route) => route.harness === input.provider)
  );
}

export function connectionAuthorizesModel(input: {
  snapshot: ProviderConnectionsSnapshot;
  connectionId: ProviderConnectionId;
  provider: ProviderKind;
  model: string;
  availableConnectionIds?: ReadonlyArray<ProviderConnectionId | null>;
}): boolean {
  if (
    input.availableConnectionIds !== undefined &&
    !input.availableConnectionIds.includes(input.connectionId)
  ) {
    return false;
  }
  const connection = input.snapshot.connections.find(
    (candidate) =>
      candidate.id === input.connectionId &&
      candidate.harness === input.provider &&
      candidate.lifecycle === "active",
  );
  if (connection === undefined) return false;
  const method = input.snapshot.authenticationMethods.find(
    (candidate) =>
      candidate.harness === connection.harness &&
      candidate.authenticationTargetId === connection.authenticationTargetId &&
      candidate.authenticationMethodId === connection.authenticationMethodId,
  );
  const internalProviderId = modelInternalProviderId(input.provider, input.model);
  if (method?.internalProviderIds.includes(internalProviderId) !== true) return false;
  const routeIsAlsoAnonymous = input.snapshot.anonymousRoutes.some(
    (route) => route.harness === input.provider && route.internalProviderId === internalProviderId,
  );
  return !routeIsAlsoAnonymous || input.availableConnectionIds !== undefined;
}

export function anonymousRouteAuthorizesModel(input: {
  snapshot: ProviderConnectionsSnapshot;
  provider: ProviderKind;
  model: string;
  availableConnectionIds?: ReadonlyArray<ProviderConnectionId | null>;
}): boolean {
  if (input.availableConnectionIds === undefined || !input.availableConnectionIds.includes(null)) {
    return false;
  }
  const internalProviderId = modelInternalProviderId(input.provider, input.model);
  return (
    internalProviderId !== null &&
    input.snapshot.anonymousRoutes.some(
      (route) =>
        route.harness === input.provider && route.internalProviderId === internalProviderId,
    )
  );
}

export function resolveComposerConnection(input: {
  snapshot: ProviderConnectionsSnapshot;
  provider: ProviderKind;
  model: string;
  availableConnectionIds?: ReadonlyArray<ProviderConnectionId | null>;
  explicitSelection: { specified: boolean; connectionId: ProviderConnectionId | null | undefined };
  startedThreadBinding: {
    loaded: boolean;
    connectionId: ProviderConnectionId | null | undefined;
  };
  hasThreadStarted: boolean;
}): ProviderConnectionId | null | undefined {
  const connectionIsValid = (connectionId: ProviderConnectionId) =>
    connectionAuthorizesModel({
      snapshot: input.snapshot,
      connectionId,
      provider: input.provider,
      model: input.model,
      ...(input.availableConnectionIds === undefined
        ? {}
        : { availableConnectionIds: input.availableConnectionIds }),
    });
  if (input.explicitSelection.specified) {
    const selected = input.explicitSelection.connectionId;
    if (
      selected === null &&
      anonymousRouteAuthorizesModel({
        snapshot: input.snapshot,
        provider: input.provider,
        model: input.model,
        ...(input.availableConnectionIds === undefined
          ? {}
          : { availableConnectionIds: input.availableConnectionIds }),
      })
    ) {
      return null;
    }
    return selected !== undefined && selected !== null && connectionIsValid(selected)
      ? selected
      : undefined;
  }
  if (input.hasThreadStarted) {
    if (!input.startedThreadBinding.loaded) return undefined;
    const bound = input.startedThreadBinding.connectionId;
    if (bound !== null && bound !== undefined) {
      // Preserve the exact historical binding even when its Connection has
      // since been disconnected. The next send must reach the server with that
      // identity and fail through the normal provider error; silently replacing
      // or suppressing it here would hide the Thread's durable state.
      return bound;
    }
    return anonymousRouteAuthorizesModel({
      snapshot: input.snapshot,
      provider: input.provider,
      model: input.model,
      ...(input.availableConnectionIds === undefined
        ? {}
        : { availableConnectionIds: input.availableConnectionIds }),
    })
      ? null
      : undefined;
  }
  const firstAvailableConnection = input.snapshot.connections.find(
    (connection) => connection.harness === input.provider && connectionIsValid(connection.id),
  )?.id;
  if (firstAvailableConnection !== undefined) return firstAvailableConnection;
  return anonymousRouteAuthorizesModel({
    snapshot: input.snapshot,
    provider: input.provider,
    model: input.model,
    ...(input.availableConnectionIds === undefined
      ? {}
      : { availableConnectionIds: input.availableConnectionIds }),
  })
    ? null
    : undefined;
}

export async function resolveComposerConnectionAtAdmission(input: {
  snapshot: ProviderConnectionsSnapshot | undefined;
  refreshSnapshot: () => Promise<ProviderConnectionsSnapshot | undefined>;
  refreshAvailableConnectionIds?: () => Promise<
    ReadonlyArray<ProviderConnectionId | null> | undefined
  >;
  provider: ProviderKind;
  model: string;
  availableConnectionIds?: ReadonlyArray<ProviderConnectionId | null>;
  explicitSelection: { specified: boolean; connectionId: ProviderConnectionId | null | undefined };
  startedThreadBinding: {
    loaded: boolean;
    connectionId: ProviderConnectionId | null | undefined;
  };
  hasThreadStarted: boolean;
}): Promise<ProviderConnectionId | null | undefined> {
  const resolve = (
    snapshot: ProviderConnectionsSnapshot,
    availableConnectionIds = input.availableConnectionIds,
  ) =>
    resolveComposerConnection({
      snapshot,
      provider: input.provider,
      model: input.model,
      ...(availableConnectionIds === undefined ? {} : { availableConnectionIds }),
      explicitSelection: input.explicitSelection,
      startedThreadBinding: input.startedThreadBinding,
      hasThreadStarted: input.hasThreadStarted,
    });
  const current = input.snapshot === undefined ? undefined : resolve(input.snapshot);
  if (current !== undefined) return current;
  const refreshed = await input.refreshSnapshot();
  if (refreshed === undefined) return undefined;
  const afterSnapshotRefresh = resolve(refreshed);
  if (afterSnapshotRefresh !== undefined || input.refreshAvailableConnectionIds === undefined) {
    return afterSnapshotRefresh;
  }
  return resolve(refreshed, await input.refreshAvailableConnectionIds());
}

export function reconcileComposerConnectionSelection(input: {
  snapshot: ProviderConnectionsSnapshot;
  provider: ProviderKind;
  model: string;
  availableConnectionIds?: ReadonlyArray<ProviderConnectionId | null>;
  current: { specified: boolean; connectionId: ProviderConnectionId | null | undefined };
}): { specified: boolean; connectionId: ProviderConnectionId | null | undefined } {
  const routeInput = {
    snapshot: input.snapshot,
    provider: input.provider,
    model: input.model,
    ...(input.availableConnectionIds === undefined
      ? {}
      : { availableConnectionIds: input.availableConnectionIds }),
  };
  if (
    input.current.specified &&
    input.current.connectionId !== null &&
    input.current.connectionId !== undefined &&
    connectionAuthorizesModel({ ...routeInput, connectionId: input.current.connectionId })
  ) {
    return input.current;
  }
  if (anonymousRouteAuthorizesModel(routeInput)) {
    return { specified: true, connectionId: null };
  }
  return { specified: false, connectionId: undefined };
}
