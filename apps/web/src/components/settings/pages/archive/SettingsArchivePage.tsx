import { RenameDialog } from "~/components/RenameDialog";
import { useStore } from "~/store";
import { IconStack2 } from "@tabler/icons-react";
import {
  THREADS_PAGE_SIZE,
  type CleanCoreArchivedChat,
  type CleanCoreListArchivedNavigationResult,
  type CleanCoreArchivedThreadCursor,
} from "@penkra/contracts";
import { useEffect, useState, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { ProviderIcon } from "~/components/ProviderIcon";
import { FolderStateIcon } from "~/components/left-rail/folder-state-icon/FolderStateIcon";
import { restoreSpace } from "~/lib/spaces";
import { restoreProject } from "~/lib/projectArchive";
import { ensureNativeApi } from "~/nativeApi";

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function Row({
  icon,
  title,
  meta,
  note,
  onRestore,
}: {
  icon: React.ReactNode;
  title: string;
  meta: string;
  note?: string | undefined;
  onRestore: () => void;
}) {
  return (
    <div className="flex min-h-[48px] items-center gap-3 px-3 py-2">
      <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground-secondary)]">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] font-medium text-[var(--color-text-foreground)]">
          {title}
        </span>
        <span className="truncate text-[11px] text-[var(--color-text-foreground-tertiary)]">
          {meta}
        </span>
        {note ? (
          <span className="truncate text-[11px] text-[var(--color-text-foreground-secondary)]">
            {note}
          </span>
        ) : null}
      </span>
      <Button onClick={onRestore} size="sm" variant="outline">
        Restore
      </Button>
    </div>
  );
}

function Section({
  title,
  count,
  children,
  empty,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
  empty: string;
}) {
  return (
    <section className="space-y-2">
      <h2 className="flex items-baseline gap-2 text-[12px] font-semibold text-[var(--color-text-foreground-tertiary)]">
        {title}
        <span className="font-normal">{count}</span>
      </h2>
      {count === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--color-border)] px-3 py-4 text-center text-[12px] text-[var(--color-text-foreground-tertiary)]">
          {empty}
        </p>
      ) : (
        <div className="divide-y divide-[var(--color-border)] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-background-surface)]">
          {children}
        </div>
      )}
    </section>
  );
}

export function SettingsArchivePage() {
  const activeSpaces = useStore((state) => state.spaces);
  const [restoreRenameSpace, setRestoreRenameSpace] = useState<
    CleanCoreListArchivedNavigationResult["spaces"][number] | null
  >(null);
  const [navigation, setNavigation] = useState<CleanCoreListArchivedNavigationResult>({
    totalChats: 0,
    spaces: [],
    folders: [],
  });
  const [chats, setChats] = useState<readonly CleanCoreArchivedChat[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<CleanCoreArchivedThreadCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const reportError = (error: unknown, title: string) =>
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    });
  const readArchive = useCallback(async () => {
    const api = ensureNativeApi();
    const [nav, page] = await Promise.all([
      api.cleanCore.listArchivedNavigation(),
      api.cleanCore.listArchivedThreads({ cursor: null }),
    ]);
    return { nav, page };
  }, []);
  const applyArchive = useCallback(({ nav, page }: Awaited<ReturnType<typeof readArchive>>) => {
    setNavigation(nav);
    setChats(page.threads);
    setTotal(nav.totalChats);
    setCursor(page.nextCursor);
  }, []);
  useEffect(() => {
    let active = true;
    void readArchive()
      .then((result) => {
        if (active) applyArchive(result);
      })
      .catch((error) => {
        if (active) reportError(error, "Could not load archive");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [readArchive, applyArchive]);
  const more = async () => {
    if (loadingMore || cursor === null) return;
    setLoadingMore(true);
    try {
      const page = await ensureNativeApi().cleanCore.listArchivedThreads({ cursor });
      setChats((rows) => [...rows, ...page.threads]);
      setCursor(page.nextCursor);
    } catch (error) {
      reportError(error, "Could not load archived chats");
    } finally {
      setLoadingMore(false);
    }
  };
  const restore = async (operation: () => Promise<void>, remove: () => void) => {
    try {
      await operation();
      remove();
    } catch (error) {
      reportError(error, "Unable to restore");
      try {
        applyArchive(await readArchive());
      } catch (readError) {
        reportError(readError, "Could not load archive");
      }
    }
  };
  if (loading)
    return (
      <p className="text-[12px] text-[var(--color-text-foreground-tertiary)]">Loading archive…</p>
    );
  return (
    <div className="flex flex-col gap-6 font-sans" data-pencil-page="archive">
      <Section count={navigation.spaces.length} empty="No archived Spaces" title="Spaces">
        {navigation.spaces.map((s) => (
          <Row
            icon={<IconStack2 className="size-4" />}
            key={s.id}
            meta={`${plural(s.folders, "folder")} · ${plural(s.chats, "chat")} · archived ${formatDate(s.archivedAt)}`}
            onRestore={() => {
              if (
                activeSpaces.some(
                  (space) => space.name.trim().toLowerCase() === s.name.trim().toLowerCase(),
                )
              ) {
                setRestoreRenameSpace(s);
                return;
              }
              void restore(
                () => restoreSpace({ api: ensureNativeApi(), spaceId: s.id }),
                () =>
                  setNavigation((nav) => ({
                    ...nav,
                    spaces: nav.spaces.filter((row) => row.id !== s.id),
                  })),
              );
            }}
            title={s.name}
          />
        ))}
      </Section>
      <Section count={navigation.folders.length} empty="No archived Folders" title="Folders">
        {navigation.folders.map((f) => (
          <Row
            icon={<FolderStateIcon open={false} iconDataUrl={f.iconDataUrl} />}
            key={f.id}
            meta={`${f.space} · ${plural(f.chats, "chat")} · archived ${formatDate(f.archivedAt)}`}
            onRestore={() =>
              void restore(
                () => restoreProject(ensureNativeApi(), f.id),
                () =>
                  setNavigation((nav) => ({
                    ...nav,
                    folders: nav.folders.filter((row) => row.id !== f.id),
                  })),
              )
            }
            title={f.name}
          />
        ))}
      </Section>
      <Section count={total} empty="No archived chats" title="Chats">
        {chats.map((c) => (
          <Row
            icon={<ProviderIcon className="size-4" provider={c.provider} />}
            key={c.id}
            meta={`${c.space} · ${c.folder} · archived ${formatDate(c.archivedAt)} · deletes in ${c.deletesInActiveDays} active days`}
            note={
              c.restoresSpace
                ? `Also restores Space “${c.space}” and Folder “${c.folder}” with only this chat`
                : c.restoresFolder
                  ? `Also restores Folder “${c.folder}” with only this chat`
                  : undefined
            }
            onRestore={() =>
              void restore(
                async () => {
                  const api = ensureNativeApi();
                  if (c.restoresSpace) await restoreSpace({ api, spaceId: c.spaceId });
                  if (c.restoresFolder) await restoreProject(api, c.folderId);
                  await api.cleanCore.restoreThread({
                    threadId: c.id,
                    updatedAt: new Date().toISOString(),
                  });
                },
                () => {
                  setChats((rows) => rows.filter((row) => row.id !== c.id));
                  setTotal((n) => n - 1);
                  setNavigation((nav) => ({
                    ...nav,
                    spaces: nav.spaces.filter((row) => !(c.restoresSpace && row.id === c.spaceId)),
                    folders: nav.folders.filter(
                      (row) => !(c.restoresFolder && row.id === c.folderId),
                    ),
                  }));
                  setChats((rows) =>
                    rows.map((row) => ({
                      ...row,
                      restoresSpace:
                        row.spaceId === c.spaceId && c.restoresSpace ? false : row.restoresSpace,
                      restoresFolder:
                        row.folderId === c.folderId && c.restoresFolder
                          ? false
                          : row.restoresFolder,
                    })),
                  );
                },
              )
            }
            title={c.title}
          />
        ))}
        {cursor !== null ? (
          <button
            className="w-full px-3 py-2.5 text-[12px] font-medium text-[var(--color-text-foreground-secondary)] hover:bg-[var(--color-background-button-secondary)]"
            disabled={loadingMore}
            onClick={() => void more()}
            type="button"
          >
            Show {Math.min(THREADS_PAGE_SIZE, total - chats.length)} more
          </button>
        ) : null}
      </Section>
      <RenameDialog
        description="An active Space already uses this name. Choose a different name to restore it with its Folders and Threads unchanged."
        initialValue={restoreRenameSpace ? `${restoreRenameSpace.name} restored` : ""}
        onOpenChange={(open) => {
          if (!open) setRestoreRenameSpace(null);
        }}
        onSave={async (name) => {
          if (!restoreRenameSpace) return;
          await restoreSpace({ api: ensureNativeApi(), spaceId: restoreRenameSpace.id, name });
          setNavigation((nav) => ({
            ...nav,
            spaces: nav.spaces.filter((row) => row.id !== restoreRenameSpace.id),
          }));
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
