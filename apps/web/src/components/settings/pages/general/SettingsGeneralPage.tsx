import { IconBrandGithub, IconBrandX, IconBrandYoutube } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import type {
  DesktopAppOpenIntent,
  DesktopAppOpenWithPreferences,
  ServerSettings,
} from "@penkra/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useAppInstallationSnapshot } from "~/appInstallationStore";
import { useSpacesUiStore } from "~/spacesUiStore";
import { APP_VERSION } from "~/branding";
import { OpenWithRowShared } from "~/components/settings/open-with-row-shared/OpenWithRowShared";
import {
  ConversationsSectionShared,
  type ConversationSteerSource,
} from "~/components/settings/conversations-section-shared/ConversationsSectionShared";
import { SettingRowShared } from "~/components/settings/setting-row-shared/SettingRowShared";
import { SettingsSectionShared } from "~/components/settings/settings-section-shared/SettingsSectionShared";
import { collectFileHandlerRows, fileTypeLabel } from "~/lib/appOpenWith";
import { serverQueryKeys, serverSettingsQueryOptions } from "~/lib/serverReactQuery";
import { ensureNativeApi } from "~/nativeApi";

export function SettingsGeneralPage() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery(serverSettingsQueryOptions());
  const writes = useRef<Promise<void>>(Promise.resolve());
  const writeRevision = useRef(0);
  const setSteer = (source: ConversationSteerSource, enabled: boolean) => {
    const current = queryClient.getQueryData<ServerSettings>(serverQueryKeys.settings());
    if (!current) return;
    const key = source === "composer" ? "steerComposerMessages" : "steerThreadMessages";
    const conversations = { ...current.conversations, [key]: enabled };
    queryClient.setQueryData(serverQueryKeys.settings(), {
      ...current,
      conversations,
    });
    const revision = ++writeRevision.current;
    writes.current = writes.current.then(async () => {
      try {
        const settings = await ensureNativeApi().server.updateSettings({
          conversations: { [key]: enabled },
        });
        if (revision === writeRevision.current)
          queryClient.setQueryData(serverQueryKeys.settings(), settings);
      } catch {
        if (revision === writeRevision.current)
          await queryClient.invalidateQueries({
            queryKey: serverQueryKeys.settings(),
          });
      }
    });
  };
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
  const enabledApps =
    installations?.installed.filter((app) => app.spaceId === activeSpaceId && isEnabled(app.id)) ??
    [];
  const directoryHandlers = enabledApps.filter((app) =>
    app.handlers.some((handler) => handler.intent === "open-directory"),
  );
  const [openWith, setOpenWith] = useState<DesktopAppOpenWithPreferences>({ files: {} });
  const discoveredFileHandlerRows = collectFileHandlerRows(enabledApps);
  const fileHandlerRows = [
    ...discoveredFileHandlerRows,
    ...Object.keys(openWith.files)
      .filter(
        (extension) =>
          !discoveredFileHandlerRows.some((candidate) => candidate.extension === extension),
      )
      .map((extension) => ({ extension, apps: [] })),
  ]
    .filter((row) => row.apps.length > 1 || openWith.files[row.extension] !== undefined)
    .sort((left, right) => left.extension.localeCompare(right.extension));

  useEffect(() => {
    let current = true;
    if (!activeSpaceId || !window.desktopBridge?.appOpenWith) {
      setOpenWith({ files: {} });
      return () => {
        current = false;
      };
    }
    void window.desktopBridge.appOpenWith.get().then((value) => {
      if (current) setOpenWith(value);
    });
    return () => {
      current = false;
    };
  }, [activeSpaceId, installations]);

  return (
    <div className="flex flex-col gap-6" data-pencil-page="general">
      <ConversationsSectionShared
        steerComposer={settingsQuery.data?.conversations.steerComposerMessages ?? false}
        steerThreads={settingsQuery.data?.conversations.steerThreadMessages ?? false}
        disabled={!settingsQuery.data}
        onSteerChange={setSteer}
      />
      <SettingsSectionShared title="Open with">
        <HandlerPreferenceRow
          apps={urlHandlers}
          intent="open-url"
          label="Links"
          onChange={setOpenWith}
          {...(openWith["open-url"] !== undefined ? { value: openWith["open-url"] } : {})}
        />
        <HandlerPreferenceRow
          apps={directoryHandlers}
          intent="open-directory"
          label="Folders"
          onChange={setOpenWith}
          {...(openWith["open-directory"] !== undefined
            ? { value: openWith["open-directory"] }
            : {})}
        />
        {fileHandlerRows.map((row) => (
          <HandlerPreferenceRow
            apps={row.apps}
            extension={row.extension}
            intent="open-file"
            key={row.extension}
            label={fileTypeLabel(row.extension)}
            onChange={setOpenWith}
            {...(openWith.files[row.extension] !== undefined
              ? { value: openWith.files[row.extension] }
              : {})}
          />
        ))}
      </SettingsSectionShared>

      <SettingsSectionShared title="About">
        <SettingRowShared
          control={
            <span className="text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground-tertiary)]">
              Up to date
            </span>
          }
          description={`Penkra console ${APP_VERSION}`}
          label="Version"
        />
        <div className="flex min-h-[51px] items-center justify-between gap-4">
          <span className="text-[length:var(--app-font-size-ui-lg,13px)] text-[var(--color-text-foreground)]">
            Follow us
          </span>
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
  extension,
  intent,
  label,
  onChange,
  value,
}: {
  apps: ReadonlyArray<{ id: string; name: string }>;
  extension?: string;
  intent: DesktopAppOpenIntent;
  label: string;
  onChange: (value: DesktopAppOpenWithPreferences) => void;
  value?: string;
}) {
  return (
    <OpenWithRowShared
      description={
        extension
          ? `Choose how Penkra opens ${extension} files.`
          : `Choose how Penkra opens ${label.toLowerCase()}.`
      }
      onValueChange={(next) => {
        if (!window.desktopBridge?.appOpenWith) return;
        void window.desktopBridge.appOpenWith
          .set({
            intent,
            ...(extension ? { extension } : {}),
            appId: next === "system" ? null : next,
          })
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
