import { IconArchive, IconArchiveOff, IconStack2 } from "@tabler/icons-react";
import { useMemo, useState } from "react";

import { RenameDialog } from "~/components/RenameDialog";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { restoreSpace } from "~/lib/spaces";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import type { Space } from "~/types";

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function ActiveSpaceRow({
  folderCount,
  space,
  threadCount,
}: {
  folderCount: number;
  space: Space;
  threadCount: number;
}) {
  const summary = [countLabel(folderCount, "Folder"), countLabel(threadCount, "Thread")].join(
    " · ",
  );
  return (
    <div
      aria-label={`${space.name} Space`}
      className="flex min-h-[54px] items-center gap-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-background-surface)] px-4"
    >
      <span className="inline-flex size-7 items-center justify-center rounded-lg bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground-secondary)]">
        <IconStack2 className="size-4" />
      </span>
      <span className="truncate text-[14px] font-semibold text-[var(--color-text-foreground)]">
        {space.name}
      </span>
      <span className="ml-auto text-[12px] text-[var(--color-text-foreground-tertiary)]">
        {summary}
      </span>
    </div>
  );
}

export function SettingsSpacesPage() {
  const spaces = useStore((store) => store.spaces);
  const archivedSpaces = useStore((store) => store.archivedSpaces);
  const projects = useStore((store) => store.projects);
  const threadShellById = useStore((store) => store.threadShellById ?? {});
  const [restoreRenameSpace, setRestoreRenameSpace] = useState<Space | null>(null);
  const countsBySpace = useMemo(() => {
    const counts = new Map<string, { folders: number; threads: number }>();
    for (const space of [...spaces, ...archivedSpaces])
      counts.set(space.id, { folders: 0, threads: 0 });
    for (const project of projects) {
      if (project.spaceId === null || project.spaceId === undefined) continue;
      const countsForSpace = counts.get(project.spaceId);
      if (countsForSpace) countsForSpace.folders += 1;
    }
    for (const thread of Object.values(threadShellById)) {
      if (thread.spaceId === null || thread.spaceId === undefined) continue;
      const countsForSpace = counts.get(thread.spaceId);
      if (countsForSpace) countsForSpace.threads += 1;
    }
    return counts;
  }, [archivedSpaces, projects, spaces, threadShellById]);

  const restore = async (space: Space, name?: string) => {
    const api = readNativeApi();
    if (!api) return;
    try {
      await restoreSpace({ api, spaceId: space.id, ...(name ? { name } : {}) });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to restore Space",
        description: error instanceof Error ? error.message : "Try again.",
      });
      throw error;
    }
  };

  return (
    <div className="flex flex-col gap-[18px] font-sans" data-pencil-page="spaces">
      <section className="space-y-2">
        <h2 className="text-[12px] font-semibold text-[var(--color-text-foreground-tertiary)]">
          Active
        </h2>
        {spaces.map((space) => {
          const counts = countsBySpace.get(space.id) ?? { folders: 0, threads: 0 };
          return (
            <ActiveSpaceRow
              folderCount={counts.folders}
              key={space.id}
              space={space}
              threadCount={counts.threads}
            />
          );
        })}
      </section>
      {archivedSpaces.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-[12px] font-semibold text-[var(--color-text-foreground-tertiary)]">
            Archived
          </h2>
          {archivedSpaces.map((space) => {
            const counts = countsBySpace.get(space.id) ?? { folders: 0, threads: 0 };
            return (
              <div
                className="flex h-[54px] items-center gap-2.5 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-background-surface)] px-3"
                key={space.id}
              >
                <IconArchive className="size-3.5 text-[var(--color-text-foreground-tertiary)]" />
                <IconStack2 className="size-4 text-[var(--color-text-foreground-secondary)]" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[13px] font-semibold text-[var(--color-text-foreground)]">
                    {space.name}
                  </span>
                  <span className="truncate text-[11px] text-[var(--color-text-foreground-tertiary)]">
                    {countLabel(counts.folders, "Folder")} · {countLabel(counts.threads, "Thread")}{" "}
                    · content preserved
                  </span>
                </span>
                <Button
                  onClick={async () => {
                    const normalizedName = space.name.trim().toLowerCase();
                    if (
                      spaces.some(
                        (activeSpace) => activeSpace.name.trim().toLowerCase() === normalizedName,
                      )
                    ) {
                      setRestoreRenameSpace(space);
                      return;
                    }
                    await restore(space);
                  }}
                  size="sm"
                  variant="outline"
                >
                  Restore
                </Button>
              </div>
            );
          })}
        </section>
      ) : null}
      <div className="flex items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-background-button-secondary)] p-3 text-[12px] leading-[1.4] text-[var(--color-text-foreground-secondary)]">
        <IconArchiveOff className="size-4 shrink-0" />
        Archiving hides a Space from the rail but keeps every Folder and Thread attached. Restore
        returns the complete Space.
      </div>
      <RenameDialog
        description="An active Space already uses this name. Choose a different name to restore it with its Folders and Threads unchanged."
        initialValue={restoreRenameSpace ? `${restoreRenameSpace.name} restored` : ""}
        onOpenChange={(open) => {
          if (!open) setRestoreRenameSpace(null);
        }}
        onSave={async (name) => {
          if (!restoreRenameSpace) return;
          await restore(restoreRenameSpace, name);
        }}
        open={restoreRenameSpace !== null}
        saveLabel="Restore"
        title={
          restoreRenameSpace ? `Rename and restore ${restoreRenameSpace.name}` : "Restore Space"
        }
      />
    </div>
  );
}
