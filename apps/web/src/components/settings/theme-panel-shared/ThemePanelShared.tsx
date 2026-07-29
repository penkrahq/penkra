import { useState } from "react";

import { SwitchShared } from "~/components/foundations/switch-shared/SwitchShared";
import { cn } from "~/lib/utils";

import { type ThemePresetName } from "../menu-theme-picker/MenuThemePicker";
import { ThemePickerShared } from "../theme-picker-shared/ThemePickerShared";

export interface ThemePanelSharedProps {
  className?: string;
  onCopyTheme?: () => void;
  onImport?: () => void;
  title?: string;
}

interface ThemeValueRowProps {
  label: string;
  value: string;
}

function ThemeValueRow({ label, value }: ThemeValueRowProps) {
  return (
    <label className="flex min-h-[44px] items-center justify-between gap-4 py-2.5">
      <span className="text-[13px] text-[var(--color-text-foreground)]">{label}</span>
      <input
        className="w-[170px] rounded-lg border border-[var(--color-border)] bg-[var(--color-background-control-opaque)] px-3 py-1.5 text-xs text-[var(--color-text-foreground-secondary)] outline-none focus:border-[var(--color-border-focus)]"
        defaultValue={value}
      />
    </label>
  );
}

export function ThemePanelShared({
  className,
  onCopyTheme,
  onImport,
  title = "Light theme",
}: ThemePanelSharedProps) {
  const [contrast, setContrast] = useState(45);
  const [preset, setPreset] = useState<ThemePresetName>("GitHub");
  const [translucentSidebar, setTranslucentSidebar] = useState(true);

  return (
    <section
      className={cn(
        "flex w-[440px] flex-col gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-background-surface)] p-5 font-sans",
        className,
      )}
      data-pencil-component="xRiiX"
    >
      <header className="flex items-center justify-between gap-4">
        <h3 className="text-[13px] font-semibold text-[var(--color-text-foreground)]">
          {title}
        </h3>
        <div className="flex items-center gap-4">
          <button
            className="cursor-pointer border-0 bg-transparent p-0 text-xs text-[var(--color-text-foreground-tertiary)] hover:text-[var(--color-text-foreground)]"
            onClick={onImport}
            type="button"
          >
            Import
          </button>
          <button
            className="cursor-pointer border-0 bg-transparent p-0 text-xs text-[var(--color-text-foreground-tertiary)] hover:text-[var(--color-text-foreground)]"
            onClick={onCopyTheme}
            type="button"
          >
            Copy theme
          </button>
          <ThemePickerShared onValueChange={setPreset} value={preset} />
        </div>
      </header>
      <div className="h-px bg-[var(--color-border)]" />
      <div className="flex flex-col">
        <label className="flex min-h-[44px] items-center justify-between gap-4 py-2.5">
          <span className="text-[13px] text-[var(--color-text-foreground)]">Accent</span>
          <span className="flex items-center gap-2 rounded-lg border border-[var(--color-border-focus)] bg-[var(--color-background-accent)] px-2.5 py-1.5">
            <input
              aria-label="Accent color"
              className="size-4 cursor-pointer appearance-none overflow-hidden rounded-full border-2 border-white bg-[#0969da] p-0 [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:border-0"
              defaultValue="#0969da"
              type="color"
            />
            <span className="text-xs text-[var(--color-text-foreground)]">#0969DA</span>
          </span>
        </label>
        <label className="flex min-h-[44px] items-center justify-between gap-4 py-2.5">
          <span className="text-[13px] text-[var(--color-text-foreground)]">
            Background
          </span>
          <span className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-background-surface)] px-2.5 py-1.5">
            <input
              aria-label="Background color"
              className="size-4 cursor-pointer appearance-none overflow-hidden rounded-full border border-[var(--color-border)] bg-white p-0 [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:border-0"
              defaultValue="#ffffff"
              type="color"
            />
            <span className="text-xs text-[var(--color-text-foreground-secondary)]">
              #FFFFFF
            </span>
          </span>
        </label>
        <label className="flex min-h-[44px] items-center justify-between gap-4 py-2.5">
          <span className="text-[13px] text-[var(--color-text-foreground)]">
            Foreground
          </span>
          <span className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-background-surface)] px-2.5 py-1.5">
            <input
              aria-label="Foreground color"
              className="size-4 cursor-pointer appearance-none overflow-hidden rounded-full border border-[var(--color-border)] bg-[#1f2328] p-0 [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:border-0"
              defaultValue="#1f2328"
              type="color"
            />
            <span className="text-xs text-[var(--color-text-foreground-secondary)]">
              #1F2328
            </span>
          </span>
        </label>
        <ThemeValueRow label="UI font" value="-apple-system, BlinkMacSystemFont" />
        <ThemeValueRow label="Code font" value={'ui-monospace, "SFMono-Regular"'} />
        <div className="flex min-h-[44px] items-center justify-between gap-4 py-2.5">
          <span className="text-[13px] text-[var(--color-text-foreground)]">
            Translucent sidebar
          </span>
          <SwitchShared
            aria-label="Translucent sidebar"
            checked={translucentSidebar}
            onCheckedChange={setTranslucentSidebar}
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
              onChange={(event) => setContrast(Number(event.target.value))}
              type="range"
              value={contrast}
            />
            <output className="w-5 text-xs text-[var(--color-text-foreground-secondary)]">
              {contrast}
            </output>
          </span>
        </label>
      </div>
    </section>
  );
}
