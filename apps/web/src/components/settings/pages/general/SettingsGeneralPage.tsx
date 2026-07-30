import { IconBrandGithub, IconBrandX, IconBrandYoutube } from "@tabler/icons-react";
import { useState } from "react";

import { APP_VERSION } from "~/branding";
import { SwitchShared } from "~/components/foundations/switch-shared/SwitchShared";
import { OpenWithRowShared } from "~/components/settings/open-with-row-shared/OpenWithRowShared";
import { SettingRowShared } from "~/components/settings/setting-row-shared/SettingRowShared";
import { SettingsSectionShared } from "~/components/settings/settings-section-shared/SettingsSectionShared";

const BROWSER_OPTIONS = [
  { id: "safari", label: "Safari" },
  { id: "chrome", label: "Google Chrome" },
  { id: "firefox", label: "Firefox" },
];

const PREVIEW_OPTIONS = [
  { id: "preview", label: "Preview" },
  { id: "finder", label: "Finder" },
  { id: "penkra", label: "Penkra" },
];

const CODE_OPTIONS = [
  { id: "cursor", label: "Cursor" },
  { id: "vscode", label: "Visual Studio Code" },
  { id: "finder", label: "Finder" },
];

export function SettingsGeneralPage() {
  const [launchAtStartup, setLaunchAtStartup] = useState(true);

  return (
    <div className="flex flex-col gap-6" data-pencil-page="general">
      <SettingsSectionShared title="Open with">
        <OpenWithRowShared
          defaultValue="safari"
          description="Web links clicked in threads."
          options={BROWSER_OPTIONS}
          title="Links"
        />
        <OpenWithRowShared
          defaultValue="preview"
          description="Image files agents create or reference."
          options={PREVIEW_OPTIONS}
          title="Images"
        />
        <OpenWithRowShared
          defaultValue="preview"
          description="PDF documents agents create or reference."
          options={PREVIEW_OPTIONS}
          title="PDFs"
        />
        <OpenWithRowShared
          defaultValue="cursor"
          description="Source and text files agents create or reference."
          options={CODE_OPTIONS}
          title="Code & text files"
        />
      </SettingsSectionShared>

      <SettingsSectionShared title="Startup">
        <SettingRowShared
          control={
            <SwitchShared
              aria-label="Launch at startup"
              checked={launchAtStartup}
              onCheckedChange={setLaunchAtStartup}
            />
          }
          description="Automatically open Penkra when your computer starts up."
          label="Launch at startup"
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
