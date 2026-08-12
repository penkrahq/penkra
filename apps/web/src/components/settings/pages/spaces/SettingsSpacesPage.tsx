import {
  IconArchive,
  IconArchiveOff,
  IconCheck,
  IconKey,
  IconStack2,
  IconUser,
} from "@tabler/icons-react";
import { PROVIDER_DISPLAY_NAMES, SpaceId, type ProviderKind } from "@penkra/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { RenameDialog } from "~/components/RenameDialog";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { toastManager } from "~/components/ui/toast";
import {
  providerConnectionQueryKeys,
  providerConnectionsQueryOptions,
} from "~/lib/providerConnectionsReactQuery";
import { activeConnectionProviders } from "~/lib/managedConnectionProviders";
import { restoreSpace } from "~/lib/spaces";
import { ensureNativeApi, readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import type { Space } from "~/types";

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function providerDisplayName(provider: ProviderKind) {
  return provider === "codex" ? "ChatGPT" : PROVIDER_DISPLAY_NAMES[provider];
}

function SpaceDefaultConnectionRow({ provider, space }: { provider: ProviderKind; space: Space }) {
  const queryClient = useQueryClient();
  const connectionsQuery = useQuery(providerConnectionsQueryOptions(SpaceId.makeUnsafe(space.id)));
  const [open, setOpen] = useState(false);
  const options = (connectionsQuery.data?.connections ?? []).filter(
    (connection) => connection.harness === provider && connection.lifecycle === "active",
  );
  if (options.length === 0) return null;
  const selectedId = connectionsQuery.data?.spaceDefaults.find(
    (entry) => entry.harness === provider,
  )?.connectionId;
  const selected = options.find((connection) => connection.id === selectedId) ?? null;
  const methodFor = (connection: (typeof options)[number]) =>
    connectionsQuery.data?.authenticationMethods.find(
      (method) =>
        method.harness === provider &&
        method.authenticationTargetId === connection.authenticationTargetId &&
        method.authenticationMethodId === connection.authenticationMethodId,
    );

  return (
    <Collapsible
      className="rounded-[10px] border border-[var(--color-border)] bg-[var(--color-background-surface)]"
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger
        aria-label={`${providerDisplayName(provider)} default Connection`}
        className="flex h-[52px] w-full items-center gap-3 px-3.5 text-left"
      >
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-background-button-secondary)]">
          <ProviderIcon className="size-4" provider={provider} />
        </span>
        <span className="text-[14px] font-semibold text-[var(--color-text-foreground)]">
          {providerDisplayName(provider)}
        </span>
        <span className="ml-auto max-w-48 truncate text-[13px] font-medium text-[var(--color-text-foreground)]">
          {selected?.label ?? "Choose Connection"}
        </span>
        <DisclosureChevron className="size-3.5" open={open} />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="flex flex-col gap-2 px-3.5 pb-3.5 pt-1">
          {options.map((connection) => {
            const method = methodFor(connection);
            const selectedOption = selectedId === connection.id;
            return (
              <button
                aria-label={`Use ${connection.label} for ${providerDisplayName(provider)}`}
                aria-pressed={selectedOption}
                className="flex h-12 w-full items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-background-button-secondary)] px-3 text-left hover:bg-[var(--color-background-button-secondary-hover)]"
                key={connection.id}
                onClick={async () => {
                  try {
                    await ensureNativeApi().provider.setSpaceDefaultConnection({
                      spaceId: SpaceId.makeUnsafe(space.id),
                      harness: provider,
                      connectionId: connection.id,
                    });
                    await queryClient.invalidateQueries({
                      queryKey: providerConnectionQueryKeys.all,
                    });
                    setOpen(false);
                  } catch (error) {
                    toastManager.add({
                      type: "error",
                      title: "Could not change the Space default",
                      description:
                        error instanceof Error ? error.message : "The Connection was not changed.",
                    });
                  }
                }}
                type="button"
              >
                {method?.kind !== "managed-login" ? (
                  <IconKey className="size-4 text-[var(--color-text-foreground-secondary)]" />
                ) : (
                  <IconUser className="size-4 text-[var(--color-text-foreground-secondary)]" />
                )}
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--color-text-foreground)]">
                  {connection.label}
                </span>
                {selectedOption ? <IconCheck className="size-4 text-accent" /> : null}
              </button>
            );
          })}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function ActiveSpaceRow({
  folderCount,
  providers,
  space,
  threadCount,
}: {
  folderCount: number;
  providers: ReadonlyArray<ProviderKind>;
  space: Space;
  threadCount: number;
}) {
  const [open, setOpen] = useState(false);
  const summary = [countLabel(folderCount, "Folder"), countLabel(threadCount, "Thread")].join(
    " · ",
  );
  return (
    <Collapsible
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-background-surface)] p-4"
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger
        aria-label={`${space.name} Space`}
        className="flex min-h-7 w-full items-center gap-2.5 text-left"
      >
        <DisclosureChevron className="size-[15px]" open={open} />
        <span className="inline-flex size-7 items-center justify-center rounded-lg bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground-secondary)]">
          <IconStack2 className="size-4" />
        </span>
        <span className="truncate text-[14px] font-semibold text-[var(--color-text-foreground)]">
          {space.name}
        </span>
        {!open ? (
          <span className="ml-auto text-[12px] text-[var(--color-text-foreground-tertiary)]">
            {summary}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="mt-3 flex flex-col gap-2">
          {providers.map((provider) => (
            <SpaceDefaultConnectionRow key={provider} provider={provider} space={space} />
          ))}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function SettingsSpacesPage() {
  const connectionsQuery = useQuery(providerConnectionsQueryOptions(null));
  const spaces = useStore((store) => store.spaces);
  const archivedSpaces = useStore((store) => store.archivedSpaces);
  const projects = useStore((store) => store.projects);
  const threadShellById = useStore((store) => store.threadShellById ?? {});
  const [restoreRenameSpace, setRestoreRenameSpace] = useState<Space | null>(null);
  const providersWithConnections = useMemo(
    () => activeConnectionProviders(connectionsQuery.data),
    [connectionsQuery.data],
  );
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
              providers={providersWithConnections}
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
