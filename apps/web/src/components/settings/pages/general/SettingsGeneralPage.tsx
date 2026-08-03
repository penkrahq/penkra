import {
  IconBell,
  IconBrandGithub,
  IconBrandX,
  IconBrandYoutube,
  IconRefresh,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { DesktopAppOpenIntent } from "@penkra/contracts";

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
      (app) =>
        app.spaceId === activeSpaceId &&
        isEnabled(app.id) &&
        app.handlers.some((handler) => handler.intent === "open-url"),
    ) ?? [];
  const fileHandlers =
    installations?.installed.filter(
      (app) =>
        app.spaceId === activeSpaceId &&
        isEnabled(app.id) &&
        app.handlers.some((handler) => handler.intent === "open-file"),
    ) ?? [];
  const directoryHandlers =
    installations?.installed.filter(
      (app) =>
        app.spaceId === activeSpaceId &&
        isEnabled(app.id) &&
        app.handlers.some((handler) => handler.intent === "open-directory"),
    ) ?? [];
  const [openWith, setOpenWith] = useState<Partial<Record<DesktopAppOpenIntent, string>>>({});

  useEffect(() => {
    let current = true;
    if (!activeSpaceId || !window.desktopBridge?.appOpenWith) {
      setOpenWith({});
      return () => {
        current = false;
      };
    }
    void window.desktopBridge.appOpenWith.get({ spaceId: activeSpaceId }).then((value) => {
      if (current) setOpenWith(value);
    });
    return () => {
      current = false;
    };
  }, [activeSpaceId]);

  return (
    <div className="flex flex-col gap-6" data-pencil-page="general">
      <SettingsSectionShared title="Open with">
        <HandlerPreferenceRow
          apps={urlHandlers}
          intent="open-url"
          label="Links"
          onChange={setOpenWith}
          spaceId={activeSpaceId}
          {...(openWith["open-url"] !== undefined ? { value: openWith["open-url"] } : {})}
        />
        <HandlerPreferenceRow
          apps={fileHandlers}
          intent="open-file"
          label="Files"
          onChange={setOpenWith}
          spaceId={activeSpaceId}
          {...(openWith["open-file"] !== undefined ? { value: openWith["open-file"] } : {})}
        />
        <HandlerPreferenceRow
          apps={directoryHandlers}
          intent="open-directory"
          label="Folders"
          onChange={setOpenWith}
          spaceId={activeSpaceId}
          {...(openWith["open-directory"] !== undefined
            ? { value: openWith["open-directory"] }
            : {})}
        />
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

function HandlerPreferenceRow({
  apps,
  intent,
  label,
  onChange,
  spaceId,
  value,
}: {
  apps: ReadonlyArray<{ id: string; name: string }>;
  intent: DesktopAppOpenIntent;
  label: string;
  onChange: (value: Partial<Record<DesktopAppOpenIntent, string>>) => void;
  spaceId: string | null;
  value?: string;
}) {
  return (
    <OpenWithRowShared
      description={`Choose how Penkra opens ${label.toLowerCase()} in this Space.`}
      onValueChange={(next) => {
        if (!spaceId || !window.desktopBridge?.appOpenWith) return;
        void window.desktopBridge.appOpenWith
          .set({ spaceId, intent, appId: next === "system" ? null : next })
          .then(onChange);
      }}
      options={[
        { id: "system", label: "System default" },
        ...apps.map((app) => ({ id: app.id, label: app.name })),
      ]}
      title={label}
      value={value ?? "system"}
    />
  );
}
