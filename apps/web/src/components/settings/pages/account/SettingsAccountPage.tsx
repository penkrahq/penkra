import type { DesktopAccountAuthState } from "@penkra/contracts";
import { useCallback, useState } from "react";

import { AvatarAccount } from "~/components/foundations/avatar-account/AvatarAccount";
import { SettingRowShared } from "~/components/settings/setting-row-shared/SettingRowShared";
import { SettingsSectionShared } from "~/components/settings/settings-section-shared/SettingsSectionShared";
import { toastManager } from "~/components/ui/toast";
import { useDesktopAccountAuthState } from "~/hooks/useDesktopAccountAuthState";
import { ensureNativeApi } from "~/nativeApi";

import { SettingsTextAction, SettingsValueAction } from "../shared/SettingsPageControls";

export function SettingsAccountPage() {
  const { accountAuth, authState } = useDesktopAccountAuthState();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const user = authState?.status === "authenticated" ? authState.user : null;
  const displayName = user?.name.trim() || user?.email.split("@")[0] || "Penkra account";
  const email = user?.email || accountStatus(authState, Boolean(accountAuth));

  const logout = useCallback(async () => {
    if (!accountAuth || isLoggingOut) return;

    const confirmed = window.desktopBridge
      ? await window.desktopBridge.confirm({
          type: "warning",
          title: "Penkra",
          message: "Log out of Penkra?",
          detail: "You’ll need to sign in again to continue.",
          cancelLabel: "Cancel",
          confirmLabel: "Log Out",
        })
      : await ensureNativeApi().dialogs.confirm(
          "Log out of Penkra?\nYou’ll need to sign in again to continue.",
        );
    if (!confirmed) return;

    setIsLoggingOut(true);
    try {
      await accountAuth.signOut();
    } catch (error) {
      setIsLoggingOut(false);
      toastManager.add({
        type: "error",
        title: "Unable to log out",
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }, [accountAuth, isLoggingOut]);

  return (
    <div className="flex flex-col gap-6" data-pencil-page="account">
      <div className="flex items-center gap-3 px-1 py-1">
        <AvatarAccount className="size-10" />
        <div className="min-w-0">
          <p className="truncate text-[length:var(--app-font-size-ui-lg,13px)] font-semibold text-[var(--color-text-foreground)]">
            {displayName}
          </p>
          <p className="text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground-tertiary)]">
            Personal account
          </p>
        </div>
      </div>

      <SettingsSectionShared title="Account">
        <SettingRowShared
          control={<SettingsValueAction>Change</SettingsValueAction>}
          description={email}
          label="Email"
        />
        <SettingRowShared
          control={<SettingsTextAction>Upgrade</SettingsTextAction>}
          description="Free plan"
          label="Plan"
        />
      </SettingsSectionShared>

      <SettingsSectionShared title="Session">
        <SettingRowShared
          control={
            <SettingsTextAction
              tone="destructive"
              {...(accountAuth && !isLoggingOut ? { onClick: () => void logout() } : {})}
            >
              {isLoggingOut ? "Logging Out…" : "Log Out"}
            </SettingsTextAction>
          }
          description="You will need to sign in again to continue."
          label="Log out of Penkra"
        />
      </SettingsSectionShared>
    </div>
  );
}

function accountStatus(state: DesktopAccountAuthState | null, hasAccountAuth: boolean): string {
  if (!hasAccountAuth) return "Account details are available in the desktop app.";
  if (!state) return "Loading account details…";
  if (state.status === "error") return state.message;
  return "Not signed in";
}
