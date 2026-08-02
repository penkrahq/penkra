import { IconPackage } from "@tabler/icons-react";

import { setInstalledAppEnabled, useAppInstallationSnapshot } from "~/appInstallationStore";
import { useSpacesUiStore } from "~/spacesUiStore";
import { toastManager } from "~/components/ui/toast";
import { SettingsInstalledRow } from "../shared/SettingsPageControls";

export function SettingsAppsPage() {
  const snapshot = useAppInstallationSnapshot();
  const activeSpaceId = useSpacesUiStore((state) => state.activeSpaceId);

  if (!snapshot) {
    return <p className="text-xs text-[var(--color-text-foreground-secondary)]">Loading installed Apps…</p>;
  }
  if (snapshot.installed.length === 0) {
    return <p className="text-xs text-[var(--color-text-foreground-secondary)]">No Apps are installed.</p>;
  }

  return (
    <div className="flex flex-col gap-2.5" data-pencil-page="apps">
      {snapshot.installed.map((app) => {
        const enabled = activeSpaceId
          ? (snapshot.spaces.find(
              (space) => space.appId === app.id && space.spaceId === activeSpaceId,
            )?.enabled ?? false)
          : false;
        return (
          <SettingsInstalledRow
            checked={enabled}
            description={`${app.summary} Version ${app.version}.`}
            disabled={!activeSpaceId}
            icon={IconPackage}
            key={app.id}
            label={app.name}
            multiline
            onCheckedChange={(nextEnabled) => {
              if (!activeSpaceId) return;
              void setInstalledAppEnabled({
                appId: app.id,
                spaceId: activeSpaceId,
                enabled: nextEnabled,
              }).catch((error: unknown) => {
                toastManager.add({
                  type: "error",
                  title: `Could not ${nextEnabled ? "enable" : "disable"} ${app.name}`,
                  description: error instanceof Error ? error.message : "The App state did not change.",
                });
              });
            }}
          />
        );
      })}
    </div>
  );
}
