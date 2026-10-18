// FILE: AdvancedSettingsPanel.tsx
// Purpose: Own advanced settings state and workflows for auth.
// Layer: Settings UI components
// Exports: AdvancedSettingsPanel

import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { logoutCurrentBrowserSession } from "~/authLogout";
import { APP_VERSION } from "~/branding";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { ensureNativeApi, readNativeApi } from "~/nativeApi";
import { serverAuthSessionQueryOptions } from "~/lib/serverReactQuery";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

export function AdvancedSettingsPanel(props: {
  active: boolean;
  onOpenReleaseHistory: () => void;
  resetEpoch: number;
}) {
  const authSessionQuery = useQuery(serverAuthSessionQueryOptions());
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const logoutCurrentSession = useCallback(async () => {
    if (isLoggingOut) return;
    const api = readNativeApi() ?? ensureNativeApi();
    setIsLoggingOut(true);
    const result = await logoutCurrentBrowserSession({
      confirm: () =>
        api.dialogs.confirm(
          "Sign out this browser?\n\nIts session and every live connection opened with it will be revoked.",
        ),
      logout: () => api.server.logoutAuthSession(),
      navigate: (path) => window.location.assign(path),
      onError: (error) =>
        toastManager.add({
          type: "error",
          title: "Sign out failed",
          description: error instanceof Error ? error.message : "Unable to revoke this session.",
        }),
    });
    if (result !== "redirecting") setIsLoggingOut(false);
  }, [isLoggingOut]);

  if (!props.active) return null;

  return (
    <div className="space-y-6">
      {authSessionQuery.data?.authenticated ? (
        <SettingsSection title="Session">
          <SettingsRow
            title="This browser"
            description="Revoke this browser session and close every live Penkra connection it owns. A fresh pairing link is required to reconnect."
            status={`Authenticated as ${authSessionQuery.data.role ?? "client"}.`}
            control={
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={isLoggingOut}
                onClick={() => void logoutCurrentSession()}
              >
                {isLoggingOut ? "Signing out..." : "Sign out"}
              </Button>
            }
          />
        </SettingsSection>
      ) : null}

      <SettingsSection title="About">
        <SettingsRow
          title="Version"
          description="Current application version."
          control={
            <code className="text-[length:var(--app-font-size-ui,12px)] font-medium text-muted-foreground">
              {APP_VERSION}
            </code>
          }
        />
        <SettingsRow
          title="Release history"
          description="A running log of every update, newest first. Same notes the post-update dialog shows, kept here so you can revisit them any time."
          control={
            <Button size="sm" variant="outline" onClick={props.onOpenReleaseHistory}>
              View release history
            </Button>
          }
        />
      </SettingsSection>
    </div>
  );
}
