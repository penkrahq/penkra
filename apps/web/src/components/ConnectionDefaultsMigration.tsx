import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useComposerDraftStore } from "../composerDraftStore";
import { connectionDefaultMigrationPatch } from "../lib/connectionDefaults";
import { serverQueryKeys, serverSettingsQueryOptions } from "../lib/serverReactQuery";
import { ensureNativeApi } from "../nativeApi";

/** Shell-owned migration; settings readers must not initialize composer persistence. */
export function ConnectionDefaultsMigration() {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery(serverSettingsQueryOptions());
  const previous = useComposerDraftStore((state) => state.stickyConnectionByProvider);

  useEffect(() => {
    if (!settings) return;
    const patch = connectionDefaultMigrationPatch(settings, previous);
    if (!Object.keys(patch.providers ?? {}).length) return;
    let current = true;
    // The host applies each seed only if no default exists. Repeated effects and
    // delayed hydration cannot replace an explicit selection from another client.
    void ensureNativeApi()
      .server.updateSettings(patch)
      .then((updated) => {
        if (current) queryClient.setQueryData(serverQueryKeys.settings(), updated);
      })
      .catch((error) => console.error("Could not migrate the default Connections", error));
    return () => {
      current = false;
    };
  }, [queryClient, settings, previous]);

  return null;
}
