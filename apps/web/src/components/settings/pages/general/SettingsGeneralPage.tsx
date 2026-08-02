import {
  IconBell,
  IconBrandGithub,
  IconBrandX,
  IconBrandYoutube,
  IconRefresh,
} from "@tabler/icons-react";

import { useAppSettings } from "~/appSettings";
import { useAppInstallationSnapshot } from "~/appInstallationStore";
import { useSpacesUiStore } from "~/spacesUiStore";
import { APP_VERSION } from "~/branding";
import { OpenWithRowShared } from "~/components/settings/open-with-row-shared/OpenWithRowShared";
import { SettingRowShared } from "~/components/settings/setting-row-shared/SettingRowShared";
import { SettingsSectionShared } from "~/components/settings/settings-section-shared/SettingsSectionShared";

const PROVIDER_UPDATE_OPTIONS = [
  { id: "automatic", icon: <IconRefresh />, label: "Automatic" },
  { id: "notify", icon: <IconBell />, label: "Notify me" },
];

export function SettingsGeneralPage() {
  const { settings, updateSettings } = useAppSettings();
  const installations = useAppInstallationSnapshot();
  const activeSpaceId = useSpacesUiStore((state) => state.activeSpaceId);
  const isEnabled = (appId: string) =>
    activeSpaceId !== null &&
    installations?.spaces.some(
      (space) => space.appId === appId && space.spaceId === activeSpaceId && space.enabled,
    ) === true;
  const urlHandlers =
    installations?.installed.filter(
      (app) => isEnabled(app.id) && app.handlers.some((handler) => handler.intent === "open-url"),
    ) ?? [];
  const fileHandlers =
    installations?.installed.filter(
      (app) => isEnabled(app.id) && app.handlers.some((handler) => handler.intent === "open-file"),
    ) ?? [];

  return (
    <div className="flex flex-col gap-6" data-pencil-page="general">
      <SettingsSectionShared title="Open with">
        <HandlerAvailabilityRow apps={urlHandlers.map((app) => app.name)} label="Links" />
        <HandlerAvailabilityRow apps={fileHandlers.map((app) => app.name)} label="Files" />
      </SettingsSectionShared>

      <SettingsSectionShared title="Notifications">
        <OpenWithRowShared
          description="Update automatically or notify you first."
          onValueChange={(providerUpdateMode) => {
            if (providerUpdateMode === "automatic" || providerUpdateMode === "notify") {
              updateSettings({ providerUpdateMode });
            }
          }}
          options={PROVIDER_UPDATE_OPTIONS}
          title="Provider updates"
          value={settings.providerUpdateMode}
        />
      </SettingsSectionShared>

      <SettingsSectionShared title="About">
        <SettingRowShared
          control={
            <span className="text-xs text-[var(--color-text-foreground-tertiary)]">Up to date</span>
          }
          description={`Penkra console ${APP_VERSION}`}
          label="Version"
        />
        <div className="flex min-h-[51px] items-center justify-between gap-4">
          <span className="text-[13px] text-[var(--color-text-foreground)]">Follow us</span>
          <span className="flex items-center gap-3 text-[var(--color-text-foreground-tertiary)]">
            <IconBrandGithub className="size-4" />
            <IconBrandX className="size-4" />
            <IconBrandYoutube className="size-4" />
          </span>
        </div>
      </SettingsSectionShared>
    </div>
  );
}

function HandlerAvailabilityRow({ apps, label }: { apps: ReadonlyArray<string>; label: string }) {
  const status =
    apps.length === 0
      ? "No compatible App installed"
      : apps.length === 1
        ? apps[0]
        : "Choose when opening";
  return (
    <SettingRowShared
      control={
        <span className="text-xs text-[var(--color-text-foreground-tertiary)]">{status}</span>
      }
      description="Resolved from enabled App handler contributions."
      label={label}
    />
  );
}
