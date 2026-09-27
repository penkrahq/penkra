// FILE: recentViews.logic.ts
// Purpose: Pure helpers for the Ctrl+Tab recent primary-view switcher.
// Layer: UI state logic
// Exports: recent view types plus MRU update, pruning, and display derivation helpers

import type { FolderId, ProviderKind, ThreadId } from "@penkra/contracts";
import type { Project, SidebarThreadSummary } from "./types";

export const MAX_RECENT_VIEWS = 5;

export type RecentView =
  | {
      kind: "thread";
      threadId: ThreadId;
    }
  | {
      kind: "settings";
      section?: string | undefined;
    };

export interface RecentViewDisplayEntry {
  key: string;
  view: RecentView;
  kind: RecentView["kind"];
  icon: RecentViewDisplayIcon;
  title: string;
  subtitle: string;
  isCurrent: boolean;
  isPinned: boolean;
  provider?: ProviderKind | undefined;
}

export type RecentViewDisplayIcon =
  | { kind: "chat" }
  | { kind: "provider"; provider: ProviderKind }
  | { kind: "settings" };

export interface RecentViewThreadDraftSummary {
  id: ThreadId;
  folderId: FolderId;
  title?: string | undefined;
  isPinned?: boolean | undefined;
}

export interface RecentViewAvailability {
  availableThreadIds: ReadonlySet<ThreadId>;
}

const SETTINGS_LABELS: Readonly<Record<string, string>> = {
  general: "General",
  appearance: "Appearance",
  providers: "Providers",
  keybindings: "Keybindings",
};

function normalizeOptionalId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
}

export function recentViewKey(view: RecentView): string {
  switch (view.kind) {
    case "thread":
      return `thread:${view.threadId}`;
    case "settings":
      return view.section ? `settings:${view.section}` : "settings";
  }
}

export function deriveCurrentRecentView(input: {
  pathname: string;
  routeThreadId: ThreadId | null;
  activeThreadId: ThreadId | null;
  settingsSection?: string | undefined;
}): RecentView | null {
  if (input.pathname === "/settings") {
    const section = normalizeOptionalId(input.settingsSection);
    return {
      kind: "settings",
      ...(section ? { section } : {}),
    };
  }

  if (input.routeThreadId) {
    return {
      kind: "thread",
      threadId: input.activeThreadId ?? input.routeThreadId,
    };
  }

  return null;
}

export function upsertRecentView(
  recentViews: readonly RecentView[],
  view: RecentView,
  limit = MAX_RECENT_VIEWS,
): RecentView[] {
  const key = recentViewKey(view);
  const deduped = recentViews.filter((entry) => recentViewKey(entry) !== key);
  return [view, ...deduped].slice(0, limit);
}

export function pruneRecentViews(
  recentViews: readonly RecentView[],
  availability: RecentViewAvailability,
  limit = MAX_RECENT_VIEWS,
): RecentView[] {
  const nextViews: RecentView[] = [];
  const seenKeys = new Set<string>();

  for (const view of recentViews) {
    const normalized = normalizeAvailableView(view, availability);
    if (!normalized) continue;

    const key = recentViewKey(normalized);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    nextViews.push(normalized);

    if (nextViews.length >= limit) break;
  }

  return nextViews;
}

function normalizeAvailableView(
  view: RecentView,
  availability: RecentViewAvailability,
): RecentView | null {
  switch (view.kind) {
    case "thread": {
      if (!availability.availableThreadIds.has(view.threadId)) {
        return null;
      }
      return view;
    }
    case "settings":
      return view;
  }
}

function resolveThreadDisplayIcon(input: {
  provider?: ProviderKind | undefined;
}): RecentViewDisplayIcon {
  if (input.provider) {
    return { kind: "provider", provider: input.provider };
  }
  return { kind: "chat" };
}

export function resolveRecentViewNavigationIndex(input: {
  recentViews: readonly RecentView[];
  currentView: RecentView | null;
  selectedKey?: string | null | undefined;
  direction: "next" | "previous";
}): number | null {
  const { recentViews, currentView, selectedKey, direction } = input;
  if (recentViews.length < 2) {
    return null;
  }

  const delta = direction === "next" ? 1 : -1;
  const preferredKey = selectedKey ?? (currentView ? recentViewKey(currentView) : null);
  const preferredIndex =
    preferredKey === null
      ? -1
      : recentViews.findIndex((view) => recentViewKey(view) === preferredKey);
  const startIndex = preferredIndex >= 0 ? preferredIndex : 0;
  return (startIndex + delta + recentViews.length) % recentViews.length;
}

export function buildRecentViewDisplayEntries(input: {
  recentViews: readonly RecentView[];
  currentView: RecentView | null;
  threadsById: Readonly<Record<string, SidebarThreadSummary | undefined>>;
  draftThreadsById?: Readonly<Record<string, RecentViewThreadDraftSummary | undefined>>;
  folders: readonly Project[];
  pinnedThreadIds: readonly ThreadId[];
}): RecentViewDisplayEntry[] {
  const currentKey = input.currentView ? recentViewKey(input.currentView) : null;
  const projectNameById = new Map(input.folders.map((project) => [project.id, project.name]));
  const pinnedThreadIds = new Set(input.pinnedThreadIds);

  return input.recentViews.map((view) => {
    const key = recentViewKey(view);
    const base = {
      key,
      view,
      kind: view.kind,
      isCurrent: key === currentKey,
      isPinned: false,
    };

    switch (view.kind) {
      case "thread": {
        const summary = input.threadsById[view.threadId];
        const thread = summary ?? input.draftThreadsById?.[view.threadId];
        const projectName = thread ? projectNameById.get(thread.folderId) : null;
        const provider = summary?.modelSelection.provider;
        const title = normalizeOptionalId(thread?.title) ?? "New chat";
        const subtitleParts = [projectName ?? "Chat", "Chat"].filter((part): part is string =>
          Boolean(part),
        );
        return {
          ...base,
          icon: resolveThreadDisplayIcon({ provider }),
          provider,
          title,
          subtitle: subtitleParts.join(" · "),
          isPinned: pinnedThreadIds.has(view.threadId) || Boolean(thread?.isPinned),
        };
      }
      case "settings":
        return {
          ...base,
          icon: { kind: "settings" },
          title: "Settings",
          subtitle: view.section ? (SETTINGS_LABELS[view.section] ?? view.section) : "App settings",
        };
    }
  });
}
