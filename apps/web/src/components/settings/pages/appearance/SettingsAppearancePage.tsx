import { useEffect, useState } from "react";

import {
  MAX_CHAT_FONT_SIZE_PX,
  MIN_CHAT_FONT_SIZE_PX,
  normalizeChatFontSizePx,
  useAppSettings,
} from "~/appSettings";
import { SettingRowShared } from "~/components/settings/setting-row-shared/SettingRowShared";
import { ThemePanelShared } from "~/components/settings/theme-panel-shared/ThemePanelShared";
import { ThemePreviewCardShared } from "~/components/settings/theme-preview-card-shared/ThemePreviewCardShared";
import { toastManager } from "~/components/ui/toast";
import { useTheme, type ThemeVariant } from "~/hooks/useTheme";

export function SettingsAppearancePage() {
  const { settings, updateSettings } = useAppSettings();
  const {
    canImportThemeString,
    darkTheme,
    exportThemeString,
    importThemeString,
    lightTheme,
    setCodeThemeId,
    setTheme,
    theme,
    updateThemeFonts,
    updateThemePack,
  } = useTheme();

  async function copyTheme(variant: ThemeVariant) {
    try {
      await navigator.clipboard.writeText(exportThemeString(variant));
      toastManager.add({ type: "success", title: `${variantLabel(variant)} theme copied` });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to copy theme",
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }

  async function importTheme(variant: ThemeVariant) {
    try {
      const value = await navigator.clipboard.readText();
      if (!canImportThemeString(value, variant)) {
        toastManager.add({
          type: "warning",
          title: "Clipboard does not contain a compatible Penkra theme",
        });
        return;
      }
      importThemeString(value, variant);
      toastManager.add({ type: "success", title: `${variantLabel(variant)} theme imported` });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to import theme",
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }

  return (
    <div className="flex w-full max-w-[560px] flex-col gap-6" data-pencil-page="appearance">
      <div className="flex w-full justify-between gap-2.5">
        <ThemePreviewCardShared
          label="System"
          mode="system"
          onClick={() => setTheme("system")}
          selected={theme === "system"}
        />
        <ThemePreviewCardShared
          label="Light"
          mode="light"
          onClick={() => setTheme("light")}
          selected={theme === "light"}
        />
        <ThemePreviewCardShared
          label="Dark"
          mode="dark"
          onClick={() => setTheme("dark")}
          selected={theme === "dark"}
        />
      </div>
      <div className="h-px w-full bg-[var(--color-border)]" />
      <ThemePanelShared
        accent={lightTheme.theme.accent}
        background={lightTheme.theme.surface}
        codeFont={lightTheme.theme.fonts.code}
        codeThemeId={lightTheme.codeThemeId}
        contrast={lightTheme.theme.contrast}
        foreground={lightTheme.theme.ink}
        mode="light"
        onAccentChange={(accent) => updateThemePack("light", { accent })}
        onBackgroundChange={(surface) => updateThemePack("light", { surface })}
        onCodeFontChange={(code) => updateThemeFonts("light", { code })}
        onCodeThemeIdChange={(codeThemeId) => setCodeThemeId("light", codeThemeId)}
        onContrastChange={(contrast) => updateThemePack("light", { contrast })}
        onCopyTheme={() => void copyTheme("light")}
        onForegroundChange={(ink) => updateThemePack("light", { ink })}
        onImport={() => void importTheme("light")}
        onTranslucentSidebarChange={(translucent) =>
          updateThemePack("light", { opaqueWindows: !translucent })
        }
        onUiFontChange={(ui) => updateThemeFonts("light", { ui })}
        title="Light theme"
        translucentSidebar={!lightTheme.theme.opaqueWindows}
        uiFont={lightTheme.theme.fonts.ui}
      />
      <ThemePanelShared
        accent={darkTheme.theme.accent}
        background={darkTheme.theme.surface}
        codeFont={darkTheme.theme.fonts.code}
        codeThemeId={darkTheme.codeThemeId}
        contrast={darkTheme.theme.contrast}
        foreground={darkTheme.theme.ink}
        mode="dark"
        onAccentChange={(accent) => updateThemePack("dark", { accent })}
        onBackgroundChange={(surface) => updateThemePack("dark", { surface })}
        onCodeFontChange={(code) => updateThemeFonts("dark", { code })}
        onCodeThemeIdChange={(codeThemeId) => setCodeThemeId("dark", codeThemeId)}
        onContrastChange={(contrast) => updateThemePack("dark", { contrast })}
        onCopyTheme={() => void copyTheme("dark")}
        onForegroundChange={(ink) => updateThemePack("dark", { ink })}
        onImport={() => void importTheme("dark")}
        onTranslucentSidebarChange={(translucent) =>
          updateThemePack("dark", { opaqueWindows: !translucent })
        }
        onUiFontChange={(ui) => updateThemeFonts("dark", { ui })}
        title="Dark theme"
        translucentSidebar={!darkTheme.theme.opaqueWindows}
        uiFont={darkTheme.theme.fonts.ui}
      />
      <SettingRowShared
        className="w-full rounded-xl border border-[var(--color-border)] px-4"
        control={
          <UiFontSizeControl
            onChange={(chatFontSizePx) => updateSettings({ chatFontSizePx })}
            value={settings.chatFontSizePx}
          />
        }
        description="Adjust the size of text across Penkra"
        label="UI font size"
      />
    </div>
  );
}

function UiFontSizeControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const next = draft.trim() === "" ? value : Number(draft);
    const normalized = normalizeChatFontSizePx(Number.isFinite(next) ? next : value);
    setDraft(String(normalized));
    if (normalized !== value) onChange(normalized);
  };

  return (
    <span className="flex shrink-0 items-center gap-2">
      <input
        aria-label="UI font size"
        className="h-8 w-16 rounded-lg border border-[var(--color-border)] bg-[var(--color-background-control-opaque)] px-2 text-center text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground)] outline-none focus:border-[var(--color-border-focus)]"
        inputMode="numeric"
        max={MAX_CHAT_FONT_SIZE_PX}
        min={MIN_CHAT_FONT_SIZE_PX}
        onBlur={commit}
        onChange={(event) => {
          const nextDraft = event.target.value;
          setDraft(nextDraft);

          if (nextDraft.trim() === "") return;
          const next = Number(nextDraft);
          if (
            Number.isInteger(next) &&
            next >= MIN_CHAT_FONT_SIZE_PX &&
            next <= MAX_CHAT_FONT_SIZE_PX &&
            next !== value
          ) {
            onChange(next);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        step="1"
        type="number"
        value={draft}
      />
      <span className="text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--color-text-foreground-tertiary)]">
        px
      </span>
    </span>
  );
}

function variantLabel(variant: ThemeVariant): string {
  return variant === "dark" ? "Dark" : "Light";
}
