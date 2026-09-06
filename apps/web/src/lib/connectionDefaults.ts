import type {
  ProviderConnectionId,
  ProviderKind,
  ServerSettingsPatch,
  ServerSettingsView,
} from "@penkra/contracts";
import { ensureNativeApi } from "../nativeApi";

export function connectionDefaultMigrationPatch(
  settings: ServerSettingsView,
  previous: Partial<Record<ProviderKind, ProviderConnectionId | null>>,
): ServerSettingsPatch {
  const providers: Record<string, { initializeDefaultConnectionId: ProviderConnectionId | null }> =
    {};
  for (const provider of Object.keys(settings.providers) as ProviderKind[]) {
    if (
      settings.providers[provider].defaultConnectionId === undefined &&
      previous[provider] !== undefined
    ) {
      providers[provider] = { initializeDefaultConnectionId: previous[provider] };
    }
  }
  return { providers };
}

export function saveDefaultConnection(
  provider: ProviderKind,
  connectionId: ProviderConnectionId | null,
) {
  return ensureNativeApi().server.updateSettings({
    providers: { [provider]: { defaultConnectionId: connectionId } },
  });
}
