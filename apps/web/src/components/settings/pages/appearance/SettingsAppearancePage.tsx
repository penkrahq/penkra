import { ThemePanelShared } from "~/components/settings/theme-panel-shared/ThemePanelShared";
import { ThemePreviewCardShared } from "~/components/settings/theme-preview-card-shared/ThemePreviewCardShared";
import { toastManager } from "~/components/ui/toast";
import { useTheme, type ThemeVariant } from "~/hooks/useTheme";

export function SettingsAppearancePage() {
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
    <div className="flex flex-col gap-6" data-pencil-page="appearance">
      <div className="flex w-[440px] justify-between gap-2.5">
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
    </div>
  );
}

function variantLabel(variant: ThemeVariant): string {
  return variant === "dark" ? "Dark" : "Light";
}
