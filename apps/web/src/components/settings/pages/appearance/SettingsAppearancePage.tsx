import { useState } from "react";

import { ThemePanelShared } from "~/components/settings/theme-panel-shared/ThemePanelShared";
import { ThemePreviewCardShared } from "~/components/settings/theme-preview-card-shared/ThemePreviewCardShared";

type PreviewMode = "dark" | "light" | "system";

export function SettingsAppearancePage() {
  const [previewMode, setPreviewMode] = useState<PreviewMode>("system");

  return (
    <div className="flex flex-col gap-6" data-pencil-page="appearance">
      <div className="flex w-[440px] justify-between gap-2.5">
        <ThemePreviewCardShared
          label="System"
          mode="system"
          onClick={() => setPreviewMode("system")}
          selected={previewMode === "system"}
        />
        <ThemePreviewCardShared
          label="Light"
          mode="light"
          onClick={() => setPreviewMode("light")}
          selected={previewMode === "light"}
        />
        <ThemePreviewCardShared
          label="Dark"
          mode="dark"
          onClick={() => setPreviewMode("dark")}
          selected={previewMode === "dark"}
        />
      </div>
      <div className="h-px w-full bg-[var(--color-border)]" />
      <ThemePanelShared mode="light" title="Light theme" />
      <ThemePanelShared mode="dark" title="Dark theme" />
    </div>
  );
}
