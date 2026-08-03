// FILE: SettingsPanelPrimitives.tsx
// Purpose: Shared settings section card and row primitives (Codex-style bordered groups).
// Layer: Settings UI components
// Exports: SettingsCard, SettingsSection, SettingsListRow, SettingsRow, SettingsSelectPopup

import { type ComponentProps, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { settingRowAnchorId } from "~/settingsNavigation";
import {
  SETTINGS_CARD_CLASS_NAME,
  SETTINGS_CARD_ROW_CLASS_NAME,
  SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME,
  SETTINGS_CARD_ROW_TITLE_CLASS_NAME,
  SETTINGS_EMPTY_STATE_CLASS_NAME,
  SETTINGS_PANEL_SECTION_CLASS_NAME,
  SETTINGS_SECTION_LABEL_CLASS_NAME,
  SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
} from "~/settingsPanelStyles";
import { SelectPopup } from "~/components/ui/select";
import { composerPickerMenuShellClassName } from "~/components/chat/composerPickerSize";
import { SettingRowShared } from "./setting-row-shared/SettingRowShared";
import { SettingsSectionShared } from "./settings-section-shared/SettingsSectionShared";

export function SettingsCard({
  divided: dividedProp,
  className,
  children,
}: {
  divided?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const divided = dividedProp ?? true;
  return (
    <div
      className={cn(
        SETTINGS_CARD_CLASS_NAME,
        divided && SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SettingsSectionShell({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={SETTINGS_PANEL_SECTION_CLASS_NAME}>
      {action != null ? (
        <div className="flex items-center justify-between gap-2">
          <h2 className={SETTINGS_SECTION_LABEL_CLASS_NAME}>{title}</h2>
          {action}
        </div>
      ) : (
        <h2 className={SETTINGS_SECTION_LABEL_CLASS_NAME}>{title}</h2>
      )}
      {children}
    </section>
  );
}

export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <SettingsSectionShared className={SETTINGS_PANEL_SECTION_CLASS_NAME} title={title}>
      {children}
    </SettingsSectionShared>
  );
}

export function SettingsEmptyState({
  layout: layoutProp,
  tone: toneProp,
  className,
  children,
}: {
  layout?: "block" | "status";
  tone?: "muted" | "destructive";
  className?: string;
  children: ReactNode;
}) {
  const layout = layoutProp ?? "block";
  const tone = toneProp ?? "muted";
  return (
    <div
      className={cn(
        SETTINGS_EMPTY_STATE_CLASS_NAME,
        "px-4 text-[length:calc(var(--app-font-size-base,12px)*1.1667)]",
        layout === "block" ? "py-10 text-center" : "py-6",
        tone === "destructive"
          ? "border-destructive/30 bg-destructive/5 text-destructive"
          : "text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Frosted select dropdown panel with settings `rounded-lg` chrome. */
export function SettingsSelectPopup({
  align = "end",
  alignItemWithTrigger = false,
  shellClassName,
  ...props
}: Omit<ComponentProps<typeof SelectPopup>, "surface">) {
  return (
    <SelectPopup
      align={align}
      alignItemWithTrigger={alignItemWithTrigger}
      surface="settings"
      shellClassName={cn(composerPickerMenuShellClassName(), shellClassName)}
      {...props}
    />
  );
}

/**
 * A list item row inside a settings card — same chrome and typography as
 * {@link SettingsRow}, but for dynamic collections (archived threads, managed
 * worktrees, …) rather than a single setting + control. It deliberately omits
 * the search anchor (titles are data, not stable setting names) and supports a
 * right-click handler plus top-alignment for rows whose body can grow tall.
 *
 * Separators come from the parent card's `divide-y` (see {@link SettingsCard} /
 * {@link SettingsSection}); the row never draws its own border.
 */
export function SettingsListRow({
  title,
  description,
  actions,
  align = "center",
  onContextMenu,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  align?: "center" | "start";
  onContextMenu?: ComponentProps<"div">["onContextMenu"];
}) {
  return (
    <div
      className={SETTINGS_CARD_ROW_CLASS_NAME}
      data-slot="settings-row"
      onContextMenu={onContextMenu}
    >
      <div
        className={cn(
          "flex flex-col gap-2.5 sm:flex-row sm:justify-between",
          align === "start" ? "sm:items-start" : "sm:items-center",
        )}
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className={cn(SETTINGS_CARD_ROW_TITLE_CLASS_NAME, "truncate")}>{title}</div>
          {description != null ? (
            <div className={SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME}>{description}</div>
          ) : null}
        </div>
        {actions != null ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SettingsRow({
  title,
  description,
  status,
  resetAction,
  control,
  children,
  onClick,
}: {
  title: ReactNode;
  description: string;
  status?: ReactNode;
  resetAction?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
  onClick?: () => void;
}) {
  // String-titled rows expose a stable anchor so the sidebar search can deep-link to them
  // via `?target=…`; scroll-margin keeps the row clear of the sticky settings header.
  const anchorId = typeof title === "string" ? settingRowAnchorId(title) : undefined;
  return (
    <SettingRowShared
      id={anchorId}
      className={cn(
        anchorId && "scroll-mt-24",
        onClick && "cursor-pointer",
        children && "flex-wrap",
      )}
      control={control}
      description={description}
      label={title}
      onClick={onClick}
      resetAction={resetAction}
      status={status}
      data-slot="settings-row"
    >
      {children}
    </SettingRowShared>
  );
}
