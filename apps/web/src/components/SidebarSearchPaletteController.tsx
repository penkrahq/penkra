// FILE: SidebarSearchPaletteController.tsx
// Purpose: Adapt paged server search results to the sidebar palette.
// Layer: Web sidebar controller

import { ProviderKind, type FolderId, type SpaceId } from "@penkra/contracts";
import { useQueries } from "@tanstack/react-query";
import { Schema } from "effect";
import { useEffect, useState } from "react";
import {
  providerComposerCapabilitiesQueryOptions,
  supportsThreadImport,
} from "../lib/providerDiscoveryReactQuery";
import { useSidebarThreadSearch } from "../hooks/useSidebarThreadSearch";
import { useThreadList } from "../threadListStore";
import {
  SidebarSearchPalette,
  type SidebarSearchPaletteMode,
  type ImportProviderKind,
} from "./SidebarSearchPalette";
import type {
  SidebarSearchAction,
  SidebarSearchProject,
  SidebarSearchThreadMatch,
} from "./SidebarSearchPalette.logic";

export function SidebarSearchPaletteController(props: {
  open: boolean;
  spaceId: SpaceId | null;
  mode: SidebarSearchPaletteMode;
  onModeChange: (mode: SidebarSearchPaletteMode) => void;
  onOpenChange: (open: boolean) => void;
  actions: readonly SidebarSearchAction[];
  folders: readonly SidebarSearchProject[];
  projectById: ReadonlyMap<FolderId, { name: string; remoteName: string }>;
  onCreateChat: () => void;
  onCreateThread: () => void;
  onOpenSettings: () => void;
  onOpenFeedback: () => void;
  onOpenUsageSettings: () => void;
  onOpenProject: (folderId: string) => void;
  onImportThread: (provider: ImportProviderKind, externalId: string) => Promise<void>;
  onOpenThread: (threadId: string) => void;
}) {
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!props.open) setQuery("");
  }, [props.open]);
  const search = useSidebarThreadSearch({
    spaceId: props.spaceId,
    query,
    enabled: props.open && props.mode === "search",
  });
  const rows = useThreadList();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const importProviderCapabilityQueries = useQueries({
    queries: (["codex", "claudeAgent", "opencode"] as const).map((provider) =>
      providerComposerCapabilitiesQueryOptions(provider),
    ),
  });
  const importProviders = (["codex", "claudeAgent", "opencode"] as const).filter(
    (provider, index) => supportsThreadImport(importProviderCapabilityQueries[index]?.data),
  );
  const threads: SidebarSearchThreadMatch[] = search.matches.flatMap((match) => {
    const thread = byId.get(match.id);
    if (thread === undefined) return [];
    return [
      {
        id: `thread:${thread.id}`,
        matchKind: match.matchKind,
        snippet: match.messageText,
        thread: {
          id: thread.id,
          title: thread.title,
          folderId: thread.folderId,
          projectName:
            thread.folderId === null
              ? "Unknown folder"
              : (props.projectById.get(thread.folderId)?.name ?? "Unknown folder"),
          provider: Schema.decodeUnknownSync(ProviderKind)(thread.provider),
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
        },
      },
    ];
  });
  return (
    <SidebarSearchPalette
      {...props}
      threads={threads}
      query={query}
      onQueryChange={setQuery}
      hasNextThreadPage={search.hasNextPage}
      loadingThreads={search.loading}
      onLoadNextThreadPage={search.loadNextPage}
      importProviders={importProviders}
    />
  );
}
