import type { DesktopAppSetting } from "@penkra/contracts";
import { useEffect, useState, type FormEvent } from "react";

import { SwitchShared } from "~/components/foundations/switch-shared/SwitchShared";
import { SettingResetButton } from "~/components/settings/SettingControls";
import { SettingRowShared } from "~/components/settings/setting-row-shared/SettingRowShared";
import { SettingsSectionShared } from "~/components/settings/settings-section-shared/SettingsSectionShared";
import { toastManager } from "~/components/ui/toast";
import {
  getInstalledAppSettings,
  resetInstalledAppSetting,
  setInstalledAppSetting,
} from "~/appInstallationStore";

export function AppContributedSettings({
  appId,
  appName,
  spaceId,
}: {
  appId: string;
  appName: string;
  spaceId: string;
}) {
  const [settings, setSettings] = useState<ReadonlyArray<DesktopAppSetting> | null>(null);
  useEffect(() => {
    let active = true;
    void getInstalledAppSettings({ appId, spaceId }).then(
      (next) => active && setSettings(next),
      (error) => active && reportSettingError(appName, error),
    );
    return () => {
      active = false;
    };
  }, [appId, appName, spaceId]);
  if (!settings || settings.length === 0) return null;

  const update = async (setting: DesktopAppSetting, value: boolean | number | string) => {
    try {
      setSettings(await setInstalledAppSetting({ appId, spaceId, key: setting.key, value }));
    } catch (error) {
      reportSettingError(appName, error);
    }
  };
  const reset = async (setting: DesktopAppSetting) => {
    try {
      setSettings(await resetInstalledAppSetting({ appId, spaceId, key: setting.key }));
    } catch (error) {
      reportSettingError(appName, error);
    }
  };

  return (
    <SettingsSectionShared className="mt-2" title={`${appName} settings`}>
      {settings.map((setting) => (
        <SettingRowShared
          control={
            <SettingControl setting={setting} update={(value) => void update(setting, value)} />
          }
          description={setting.description}
          key={setting.key}
          label={setting.label}
          resetAction={
            setting.configured ? (
              <SettingResetButton label={setting.label} onClick={() => void reset(setting)} />
            ) : null
          }
          status={
            setting.type === "string" && setting.sensitive && setting.configured
              ? "A value is stored securely."
              : null
          }
        />
      ))}
    </SettingsSectionShared>
  );
}

function SettingControl({
  setting,
  update,
}: {
  setting: DesktopAppSetting;
  update(value: boolean | number | string): void;
}) {
  if (setting.type === "boolean") {
    return (
      <SwitchShared aria-label={setting.label} checked={setting.value} onCheckedChange={update} />
    );
  }
  if (setting.type === "select") {
    return (
      <select
        aria-label={setting.label}
        className="h-8 min-w-36 rounded-lg border border-[var(--color-border)] bg-[var(--color-background-surface)] px-2 text-xs text-[var(--color-text-foreground)] outline-none focus-visible:border-[var(--color-border-focus)]"
        onChange={(event) => update(event.currentTarget.value)}
        value={setting.value}
      >
        {setting.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  return <CommittedInput setting={setting} update={update} />;
}

function CommittedInput({
  setting,
  update,
}: {
  setting: Extract<DesktopAppSetting, { type: "number" | "string" }>;
  update(value: number | string): void;
}) {
  const displayed = setting.type === "string" && setting.sensitive ? "" : String(setting.value);
  const [draft, setDraft] = useState(displayed);
  useEffect(() => setDraft(displayed), [displayed]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (setting.type === "number") {
      const value = Number(draft);
      if (Number.isFinite(value)) update(value);
      return;
    }
    update(draft);
    if (setting.sensitive) setDraft("");
  };
  return (
    <form className="flex items-center gap-1.5" onSubmit={submit}>
      <input
        aria-label={setting.label}
        className="h-8 w-40 rounded-lg border border-[var(--color-border)] bg-[var(--color-background-surface)] px-2 text-xs text-[var(--color-text-foreground)] outline-none placeholder:text-[var(--color-text-foreground-tertiary)] focus-visible:border-[var(--color-border-focus)]"
        max={setting.type === "number" ? setting.validation?.maximum : undefined}
        maxLength={setting.type === "string" ? setting.validation?.maxLength : undefined}
        min={setting.type === "number" ? setting.validation?.minimum : undefined}
        minLength={setting.type === "string" ? setting.validation?.minLength : undefined}
        onChange={(event) => setDraft(event.currentTarget.value)}
        placeholder={
          setting.type === "string" && setting.sensitive && setting.configured
            ? "Replace saved value"
            : undefined
        }
        step={setting.type === "number" ? setting.validation?.step : undefined}
        type={setting.type === "number" ? "number" : setting.sensitive ? "password" : "text"}
        value={draft}
      />
      <button
        className="h-8 rounded-lg border border-[var(--color-border)] px-2 text-xs text-[var(--color-text-foreground-secondary)] hover:text-[var(--color-text-foreground)]"
        type="submit"
      >
        Save
      </button>
    </form>
  );
}

function reportSettingError(appName: string, error: unknown): void {
  toastManager.add({
    type: "error",
    title: `Could not update ${appName} settings`,
    description: error instanceof Error ? error.message : "The setting did not change.",
  });
}
