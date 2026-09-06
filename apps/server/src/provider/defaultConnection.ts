import type {
  ProviderConnection,
  ProviderConnectionId,
  ProviderKind,
  ServerSettings,
} from "@penkra/contracts";
import { getProviderConnectionManifest } from "./providerConnectionManifests.ts";

/** Resolve account intent before looking up models. Never choose by database order. */
export function resolveDefaultConnection(input: {
  provider: ProviderKind;
  connectionId?: ProviderConnectionId | null;
  settings: ServerSettings;
  connections: ReadonlyArray<ProviderConnection>;
}): ProviderConnectionId | null {
  const requested =
    input.connectionId !== undefined
      ? input.connectionId
      : input.settings.providers[input.provider].defaultConnectionId;
  if (requested === null) {
    if (getProviderConnectionManifest(input.provider)?.anonymous) return null;
    throw new Error("This provider has no anonymous Connection.");
  }
  const active = input.connections.filter(
    (entry) => entry.harness === input.provider && entry.lifecycle === "active",
  );
  if (requested !== undefined) {
    if (active.some((entry) => entry.id === requested)) return requested;
    throw new Error(
      "The selected Connection is unavailable. Select or reconnect it; another account will not be substituted.",
    );
  }
  if (active.length === 1) return active[0]!.id;
  if (active.length > 1)
    throw new Error("Choose a default Connection or supply an explicit Connection.");
  if (getProviderConnectionManifest(input.provider)?.anonymous) return null;
  throw new Error("No Connection is available for this provider.");
}
