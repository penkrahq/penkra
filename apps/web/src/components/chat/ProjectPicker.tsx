// FILE: ProjectPicker.tsx
// Purpose: Selects the immutable physical folder for a draft thread from parent-scoped recents
//          or the native folder picker.
// Layer: Chat / empty-state entrypoint

import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import type { ContainerId, SpaceId } from "@penkra/contracts";

import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { createSidebarDisplayThreadsSelector } from "../../storeSelectors";
import { PlusIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ELEVATED_HOVER_SURFACE_CLASS_NAME } from "~/surfaceStyles";
import { FolderClosed } from "../FolderClosed";
import {
  Combobox,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
import { PickerTriggerButton } from "./PickerTriggerButton";

interface ProjectPickerProps {
  align?: "start" | "center" | "end";
  side?: "top" | "bottom";
  recentProjectId: ContainerId;
  recentSpaceId?: SpaceId | null;
  selectedWorkspaceRoot?: string | null;
  onSelectWorkspaceRoot: (workspaceRoot: string) => void;
  onResetToHome: () => void | Promise<void>;
  triggerClassName?: string;
  renderTrigger?: ReactElement<Record<string, unknown>>;
  emptyTriggerLabel?: string;
  addActionLabel?: string;
  resetActionLabel?: string;
  variant?: "default" | "draft-bar";
}

const PICKER_FOOTER_ACTION_CLASS_NAME = cn(
  "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[length:var(--app-font-size-ui,12px)] font-normal",
  ELEVATED_HOVER_SURFACE_CLASS_NAME,
  "hover:text-[var(--color-text-foreground)]",
);

export function basenameOfPath(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  const basename = separatorIndex === -1 ? normalized : normalized.slice(separatorIndex + 1);
  return basename.length > 0 ? basename : null;
}

export function projectPickerProjectLabels(project: {
  id: string;
  name: string;
  localName?: string | null;
  cwd: string;
}): { primaryLabel: string | null; secondaryLabel: string | null } {
  const folderName = basenameOfPath(project.cwd) ?? project.name;
  const localName = project.localName?.trim() ?? "";
  return {
    primaryLabel: localName || folderName,
    secondaryLabel: localName && localName !== folderName ? folderName : null,
  };
}

function normalizePathKey(path: string): string {
  return path.replace(/[\\/]+$/, "").toLowerCase();
}

export const ProjectPicker = memo(function ProjectPicker({
  align: alignProp,
  side: sideProp,
  recentProjectId,
  recentSpaceId: recentSpaceIdProp,
  selectedWorkspaceRoot: selectedWorkspaceRootProp,
  onSelectWorkspaceRoot,
  onResetToHome,
  triggerClassName,
  renderTrigger,
  emptyTriggerLabel: emptyTriggerLabelProp,
  addActionLabel: addActionLabelProp,
  resetActionLabel: resetActionLabelProp,
  variant: variantProp,
}: ProjectPickerProps) {
  const align = alignProp ?? "start";
  const side = sideProp ?? "top";
  const recentSpaceId = recentSpaceIdProp ?? null;
  const selectedWorkspaceRoot = selectedWorkspaceRootProp ?? null;
  const emptyTriggerLabel = emptyTriggerLabelProp ?? "Choose Folder";
  const addActionLabel = addActionLabelProp ?? "Choose from computer…";
  const resetActionLabel = resetActionLabelProp ?? "Don't work in a folder";
  const variant = variantProp ?? "default";
  const sidebarThreads = useStore(useMemo(() => createSidebarDisplayThreadsSelector(), []));
  const [open, setOpen] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const recentFolders = useMemo(() => {
    const seen = new Set<string>();
    return sidebarThreads
      .filter(
        (thread) =>
          thread.projectId === recentProjectId &&
          (thread.spaceId ?? null) === recentSpaceId &&
          Boolean(thread.workingDirectory),
      )
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
      .flatMap((thread) => {
        const path = thread.workingDirectory?.trim() ?? "";
        const label = basenameOfPath(path);
        const key = normalizePathKey(path);
        if (!path || !label || label.startsWith(".") || seen.has(key)) return [];
        seen.add(key);
        return [{ path, label }];
      });
  }, [recentProjectId, recentSpaceId, sidebarThreads]);
  const recentPaths = useMemo(() => recentFolders.map((folder) => folder.path), [recentFolders]);
  const selectedLabel = basenameOfPath(selectedWorkspaceRoot);

  const handlePickFromComputer = useCallback(async () => {
    if (isPicking) return;
    const api = readNativeApi();
    if (!api) {
      setErrorMessage("App is still connecting. Try again in a moment.");
      return;
    }
    setIsPicking(true);
    setErrorMessage(null);
    try {
      const pickedPath = await api.dialogs.pickFolder();
      if (pickedPath) {
        onSelectWorkspaceRoot(pickedPath);
        setOpen(false);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to open the folder picker.");
    } finally {
      setIsPicking(false);
    }
  }, [isPicking, onSelectWorkspaceRoot]);

  const handleReset = useCallback(() => {
    try {
      void Promise.resolve(onResetToHome())
        .then(() => setOpen(false))
        .catch((error) => {
          setErrorMessage(error instanceof Error ? error.message : "Unable to update folder.");
        });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to update folder.");
    }
  }, [onResetToHome]);

  return (
    <Combobox
      items={recentPaths}
      filteredItems={recentPaths}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setErrorMessage(null);
      }}
      open={open}
    >
      <ComboboxTrigger
        render={
          renderTrigger ?? (
            <PickerTriggerButton
              data-testid="workspace-picker-trigger"
              icon={
                <FolderClosed className={variant === "draft-bar" ? "size-[15px]" : "size-3.5"} />
              }
              label={selectedLabel ?? emptyTriggerLabel}
              className={cn(
                variant === "draft-bar" &&
                  "h-[26px] max-w-none shrink-0 gap-[7px] px-1.5 py-0 text-[length:var(--app-font-size-ui,12px)] font-medium text-[var(--color-text-foreground)] sm:max-w-none sm:px-1.5 [&>span]:gap-[7px] [&>span>span:first-child]:size-[15px] [&>span>svg]:size-3 [&>span>svg]:opacity-100",
                triggerClassName,
              )}
            />
          )
        }
      />
      <ComboboxPopup
        align={align}
        side={side}
        sideOffset={6}
        className="w-[264px] min-w-[264px] rounded-[10px] p-2"
      >
        <div className="flex w-full flex-col gap-0.5" data-pencil-component="MFAws">
          <ComboboxList className="not-empty:!p-0">
            {recentFolders.map((folder, index) => (
              <ComboboxItem
                hideIndicator={folder.path !== selectedWorkspaceRoot}
                key={folder.path}
                index={index}
                value={folder.path}
                onClick={() => {
                  onSelectWorkspaceRoot(folder.path);
                  setOpen(false);
                }}
                className={cn(
                  "h-8 min-h-8 gap-2 rounded-lg px-2 py-0 text-[length:var(--app-font-size-ui,12px)] font-normal sm:min-h-8 sm:text-[length:var(--app-font-size-ui,12px)] [&>div:last-child_svg]:size-3.5 [&>div:last-child_svg]:text-[var(--color-accent-blue)]",
                  folder.path === selectedWorkspaceRoot &&
                    "bg-[var(--color-background-elevated-secondary)] text-[var(--color-text-foreground)]",
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <FolderClosed className="size-[15px] shrink-0 text-[var(--color-text-foreground-secondary)]" />
                  <span className="truncate">{folder.label}</span>
                </div>
              </ComboboxItem>
            ))}
          </ComboboxList>
          {recentFolders.length > 0 ? (
            <div className="h-px w-full bg-[var(--color-border)]" />
          ) : null}
          <button
            type="button"
            className={cn(
              PICKER_FOOTER_ACTION_CLASS_NAME,
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
            onClick={() => void handlePickFromComputer()}
            disabled={isPicking}
          >
            <PlusIcon className="size-[15px] shrink-0 text-[var(--color-text-foreground-tertiary)]" />
            <span className="truncate">
              {isPicking ? "Opening folder picker…" : addActionLabel}
            </span>
          </button>
          <button type="button" className={PICKER_FOOTER_ACTION_CLASS_NAME} onClick={handleReset}>
            <XIcon className="size-[15px] shrink-0 text-[var(--color-text-foreground-tertiary)]" />
            <span className="truncate">{resetActionLabel}</span>
          </button>
          {errorMessage ? (
            <div className="px-2 pb-1 text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
              {errorMessage}
            </div>
          ) : null}
        </div>
      </ComboboxPopup>
    </Combobox>
  );
});
