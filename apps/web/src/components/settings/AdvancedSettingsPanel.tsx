// FILE: AdvancedSettingsPanel.tsx
// Purpose: Own advanced settings state and workflows for auth and keybindings.
// Layer: Settings UI components
// Exports: AdvancedSettingsPanel

import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { logoutCurrentBrowserSession } from "~/authLogout";
import { APP_VERSION } from "~/branding";
import { resolveAndPersistPreferredEditor } from "~/editorPreferences";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { ensureNativeApi, readNativeApi } from "~/nativeApi";
import { serverAuthSessionQueryOptions, serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { useSettingsRestoreSignal } from "./SettingControls";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

export function AdvancedSettingsPanel(props: {
  active: boolean;
  onOpenReleaseHistory: () => void;
  resetEpoch: number;
}) {
  const configQuery = useQuery(serverConfigQueryOptions());
  const authSessionQuery = useQuery(serverAuthSessionQueryOptions());
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);

  useSettingsRestoreSignal(props.resetEpoch, () => {
    setOpenKeybindingsError(null);
  });

  const keybindingsConfigPath = configQuery.data?.keybindingsConfigPath ?? null;
  const availableEditors = configQuery.data?.availableEditors;
  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);
    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenKeybindingsError("No available editors found.");
      setIsOpeningKeybindings(false);
      return;
    }
    void ensureNativeApi()
      .shell.openInEditor(keybindingsConfigPath, editor)
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => {
        setIsOpeningKeybindings(false);
      });
  }, [availableEditors, keybindingsConfigPath]);

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

      <SettingsSection title="Developer tools">
        <SettingsRow
          title="Keybindings"
          description="Open the persisted `keybindings.json` file to edit advanced bindings directly."
          status={
            <>
              <span className="block break-all font-mono text-[length:var(--app-font-size-ui-sm,11px)] text-foreground">
                {keybindingsConfigPath ?? "Resolving keybindings path..."}
              </span>
              {openKeybindingsError ? (
                <span className="mt-1 block text-destructive">{openKeybindingsError}</span>
              ) : (
                <span className="mt-1 block">Opens in your preferred editor.</span>
              )}
            </>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!keybindingsConfigPath || isOpeningKeybindings}
              onClick={openKeybindingsFile}
            >
              {isOpeningKeybindings ? "Opening..." : "Open file"}
            </Button>
          }
        />
      </SettingsSection>

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
