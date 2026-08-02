import { useState } from "react";

import { SwitchShared } from "~/components/foundations/switch-shared/SwitchShared";
import { cn } from "~/lib/utils";
import type { ThemeVariant } from "~/theme/theme.logic";

import { ThemePickerShared } from "../theme-picker-shared/ThemePickerShared";

export interface ThemePanelSharedProps {
  accent?: string;
  background?: string;
  className?: string;
  codeFont?: string | null;
  codeThemeId?: string;
  contrast?: number;
  foreground?: string;
  mode?: ThemeVariant;
  onAccentChange?: (value: string) => void;
  onBackgroundChange?: (value: string) => void;
  onCodeFontChange?: (value: string | null) => void;
  onCodeThemeIdChange?: (value: string) => void;
  onContrastChange?: (value: number) => void;
  onCopyTheme?: () => void;
  onForegroundChange?: (value: string) => void;
  onImport?: () => void;
  onTranslucentSidebarChange?: (value: boolean) => void;
  onUiFontChange?: (value: string | null) => void;
  title?: string;
  translucentSidebar?: boolean;
  uiFont?: string | null;
}

interface ThemeValueRowProps {
  label: string;
  onValueChange?: ((value: string | null) => void) | undefined;
  placeholder: string;
  value?: string | null | undefined;
}

function ThemeValueRow({ label, onValueChange, placeholder, value }: ThemeValueRowProps) {
  const [internalValue, setInternalValue] = useState(value ?? "");
  const selectedValue = value === undefined ? internalValue : (value ?? "");
  return (
    <label className="flex min-h-[44px] items-center justify-between gap-4 py-2.5">
      <span className="text-[13px] text-[var(--color-text-foreground)]">{label}</span>
      <input
        className="w-[170px] rounded-lg border border-[var(--color-border)] bg-[var(--color-background-control-opaque)] px-3 py-1.5 text-xs text-[var(--color-text-foreground-secondary)] outline-none focus:border-[var(--color-border-focus)]"
        onChange={(event) => {
          const next = event.target.value;
          if (value === undefined) setInternalValue(next);
          onValueChange?.(next.trim().length > 0 ? next : null);
        }}
        placeholder={placeholder}
        value={selectedValue}
      />
    </label>
  );
}

export function ThemePanelShared({
  accent,
  background,
  className,
  codeFont,
  codeThemeId,
  contrast,
  foreground,
  mode = "light",
  onAccentChange,
  onBackgroundChange,
  onCodeFontChange,
  onCodeThemeIdChange,
  onContrastChange,
  onCopyTheme,
  onForegroundChange,
  onImport,
  onTranslucentSidebarChange,
  onUiFontChange,
  title = "Light theme",
  translucentSidebar,
  uiFont,
}: ThemePanelSharedProps) {
  const dark = mode === "dark";
  const [internalContrast, setInternalContrast] = useState(dark ? 60 : 45);
  const [internalCodeThemeId, setInternalCodeThemeId] = useState("codex");
  const [internalTranslucentSidebar, setInternalTranslucentSidebar] = useState(true);
  const selectedAccent = accent ?? (dark ? "#1f6feb" : "#0969da");
  const selectedBackground = background ?? (dark ? "#0d1117" : "#ffffff");
  const selectedForeground = foreground ?? (dark ? "#e6edf3" : "#1f2328");
  const selectedContrast = contrast ?? internalContrast;
  const selectedCodeThemeId = codeThemeId ?? internalCodeThemeId;
  const selectedTranslucentSidebar = translucentSidebar ?? internalTranslucentSidebar;

  return (
    <section
      className={cn(
        "flex w-[440px] flex-col gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-background-surface)] p-5 font-sans",
        className,
      )}
      data-pencil-component="xRiiX"
    >
      <header className="flex items-center justify-between gap-4">
        <h3 className="text-[13px] font-semibold text-[var(--color-text-foreground)]">{title}</h3>
        <div className="flex items-center gap-4">
          <button
            className="cursor-pointer border-0 bg-transparent p-0 text-xs text-[var(--color-text-foreground-tertiary)] hover:text-[var(--color-text-foreground)] disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!onImport}
            onClick={onImport}
            type="button"
          >
            Import
          </button>
          <button
            className="cursor-pointer border-0 bg-transparent p-0 text-xs text-[var(--color-text-foreground-tertiary)] hover:text-[var(--color-text-foreground)] disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!onCopyTheme}
            onClick={onCopyTheme}
            type="button"
          >
            Copy theme
          </button>
          <ThemePickerShared
            mode={mode}
            onValueChange={(value) => {
              if (codeThemeId === undefined) setInternalCodeThemeId(value);
              onCodeThemeIdChange?.(value);
            }}
            value={selectedCodeThemeId}
          />
        </div>
      </header>
      <div className="h-px bg-[var(--color-border)]" />
      <div className="flex flex-col">
        <ColorRow accent label="Accent" onValueChange={onAccentChange} value={selectedAccent} />
        <ColorRow
          label="Background"
          onValueChange={onBackgroundChange}
          value={selectedBackground}
        />
        <ColorRow
          label="Foreground"
          onValueChange={onForegroundChange}
          value={selectedForeground}
        />
        <ThemeValueRow
          label="UI font"
          onValueChange={onUiFontChange}
          placeholder="System UI"
          value={uiFont}
        />
        <ThemeValueRow
          label="Code font"
          onValueChange={onCodeFontChange}
          placeholder="System monospace"
          value={codeFont}
        />
        <div className="flex min-h-[44px] items-center justify-between gap-4 py-2.5">
          <span className="text-[13px] text-[var(--color-text-foreground)]">
            Translucent sidebar
          </span>
          <SwitchShared
            aria-label="Translucent sidebar"
            checked={selectedTranslucentSidebar}
            onCheckedChange={(value) => {
              if (translucentSidebar === undefined) setInternalTranslucentSidebar(value);
              onTranslucentSidebarChange?.(value);
            }}
          />
        </div>
        <label className="flex min-h-[44px] items-center justify-between gap-4 py-2.5">
          <span className="text-[13px] text-[var(--color-text-foreground)]">Contrast</span>
          <span className="flex items-center gap-3">
            <input
              aria-label="Contrast"
              className="w-[120px] accent-[var(--color-text-accent)]"
              max="100"
              min="0"
              onChange={(event) => {
                const value = Number(event.target.value);
                if (contrast === undefined) setInternalContrast(value);
                onContrastChange?.(value);
              }}
              type="range"
              value={selectedContrast}
            />
            <output className="w-5 text-xs text-[var(--color-text-foreground-secondary)]">
              {selectedContrast}
            </output>
          </span>
        </label>
      </div>
    </section>
  );
}

function ColorRow({
  accent = false,
  label,
  onValueChange,
  value,
}: {
  accent?: boolean;
  label: string;
  onValueChange?: ((value: string) => void) | undefined;
  value: string;
}) {
  return (
    <label className="flex min-h-[44px] items-center justify-between gap-4 py-2.5">
      <span className="text-[13px] text-[var(--color-text-foreground)]">{label}</span>
      <span
        className={cn(
          "flex items-center gap-2 rounded-lg border bg-[var(--color-background-surface)] px-2.5 py-1.5",
          accent
            ? "border-[var(--color-border-focus)] bg-[var(--color-background-accent)]"
            : "border-[var(--color-border)]",
        )}
      >
        <input
          aria-label={`${label} color`}
          className="size-4 cursor-pointer appearance-none overflow-hidden rounded-full border border-[var(--color-border)] p-0 [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:border-0"
          onChange={(event) => onValueChange?.(event.target.value)}
          type="color"
          value={value}
        />
        <span
          className={cn(
            "text-xs text-[var(--color-text-foreground-secondary)]",
            accent && "text-[var(--color-text-foreground)]",
          )}
        >
          {value.toUpperCase()}
        </span>
      </span>
    </label>
  );
}
