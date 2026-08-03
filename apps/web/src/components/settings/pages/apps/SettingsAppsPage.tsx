import { IconPackage } from "@tabler/icons-react";

import { setInstalledAppEnabled, useAppInstallationSnapshot } from "~/appInstallationStore";
import { useSpacesUiStore } from "~/spacesUiStore";
import { toastManager } from "~/components/ui/toast";
import { SettingsInstalledRow } from "../shared/SettingsPageControls";
import { AppDiagnosticsView } from "./AppDiagnosticsView";
import { AppContributedSettings } from "./AppContributedSettings";
import { AppContributedSkills } from "./AppContributedSkills";

export function SettingsAppsPage() {
  const snapshot = useAppInstallationSnapshot();
  const activeSpaceId = useSpacesUiStore((state) => state.activeSpaceId);
  const apps = snapshot?.installed.filter((app) => app.spaceId === activeSpaceId) ?? [];

  if (!snapshot) {
    return (
      <p className="text-xs text-[var(--color-text-foreground-secondary)]">
        Loading installed Apps…
      </p>
    );
  }
  if (apps.length === 0) {
    return (
      <p className="text-xs text-[var(--color-text-foreground-secondary)]">
        No Apps are installed.
      </p>
    );
  }

  return (
    <div data-pencil-page="apps">
      <div className="flex flex-col gap-2.5">
        {apps.map((app) => {
          const spaceState = activeSpaceId
            ? snapshot.spaces.find(
                (space) => space.appId === app.id && space.spaceId === activeSpaceId,
              )
            : undefined;
          const enabled = spaceState?.enabled ?? false;
          return (
            <div key={`${app.spaceId}:${app.id}`}>
              <SettingsInstalledRow
                checked={enabled}
                description={`${app.summary} Version ${app.version}.`}
                disabled={!activeSpaceId}
                icon={IconPackage}
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
                      description:
                        error instanceof Error ? error.message : "The App state did not change.",
                    });
                  });
                }}
              />
              {enabled && activeSpaceId ? (
                <>
                  <AppContributedSettings
                    appId={app.id}
                    appName={app.name}
                    spaceId={activeSpaceId}
                  />
                  <AppContributedSkills
                    appId={app.id}
                    appName={app.name}
                    overrides={spaceState?.skills ?? {}}
                    skills={app.skills}
                    spaceId={activeSpaceId}
                  />
                </>
              ) : null}
            </div>
          );
        })}
      </div>
      <AppDiagnosticsView apps={apps} spaceId={activeSpaceId} />
    </div>
  );
}
