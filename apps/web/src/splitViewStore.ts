// FILE: splitViewStore.ts
// Purpose: Persists split chat surfaces as a recursive pane tree (depth-cap 2 = up to 2x2 grid).
// Layer: UI state store
// Exports: pane/split types, tree-aware selectors, and id-based mutation helpers used by sidebar and route surfaces

import { type FolderId, type ThreadId } from "@penkra/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { randomUUID } from "./lib/utils";
import {
  canSubdividePane,
  collectLeaves,
  findLeafPaneById,
  findSplitNodeById,
  removeLeafByPaneId,
  removeLeafByThreadId as removeLeafByThreadIdInTree,
  replacePaneInTree,
  resolveDefaultFocusLeafId,
} from "./splitView.logic";

export type SplitViewId = string;
export type PaneId = string;
export type SplitDirection = "horizontal" | "vertical";
// "first" maps to the top/left side of a split; "second" maps to the bottom/right side.
export type SplitDropSide = "first" | "second";

export interface LeafPane {
  kind: "leaf";
  id: PaneId;
  threadId: ThreadId | null;
}

export interface SplitNode {
  kind: "split";
  id: PaneId;
  direction: SplitDirection;
  // first = left (horizontal) | top (vertical); second = right | bottom.
  first: Pane;
  second: Pane;
  ratio: number;
}

export type Pane = LeafPane | SplitNode;

export interface SplitView {
  id: SplitViewId;
  sourceThreadId: ThreadId;
  ownerFolderId: FolderId;
  root: Pane;
  focusedPaneId: PaneId;
  createdAt: string;
  updatedAt: string;
}

interface CreateFromThreadInput {
  sourceThreadId: ThreadId;
  ownerFolderId: FolderId;
}

interface CreateFromDropInput {
  sourceThreadId: ThreadId;
  ownerFolderId: FolderId;
  droppedThreadId: ThreadId;
  direction: SplitDirection;
  side: SplitDropSide;
}

interface DropThreadOnPaneInput {
  splitViewId: SplitViewId;
  targetPaneId: PaneId;
  direction: SplitDirection;
  side: SplitDropSide;
  threadId: ThreadId;
}

interface RemovePaneFromSplitViewInput {
  splitViewId: SplitViewId;
  paneId: PaneId;
}

interface SplitViewStore {
  hasHydrated: boolean;
  splitViewsById: Record<SplitViewId, SplitView | undefined>;
  splitViewIdBySourceThreadId: Record<string, SplitViewId | undefined>;
  createFromThread: (input: CreateFromThreadInput) => SplitViewId;
  createFromDrop: (input: CreateFromDropInput) => SplitViewId;
  removeSplitView: (splitViewId: SplitViewId) => void;
  replacePaneThread: (splitViewId: SplitViewId, paneId: PaneId, threadId: ThreadId | null) => void;
  dropThreadOnPane: (input: DropThreadOnPaneInput) => boolean;
  removePaneFromSplitView: (input: RemovePaneFromSplitViewInput) => boolean;
  setFocusedPane: (splitViewId: SplitViewId, paneId: PaneId) => void;
  setRatioForNode: (splitViewId: SplitViewId, splitNodeId: PaneId, ratio: number) => void;
  removeThreadFromSplitViews: (threadId: ThreadId) => void;
  setHasHydrated: (hasHydrated: boolean) => void;
}

const SPLIT_VIEW_STORAGE_KEY = "penkra:split-threads:v1";
const DEFAULT_RATIO = 0.5;
const MIN_RATIO = 0.25;
const MAX_RATIO = 0.75;

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RATIO;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
}

function createLeafPane(threadId: ThreadId | null): LeafPane {
  return {
    kind: "leaf",
    id: randomUUID(),
    threadId,
  };
}

function createSplitNode(input: {
  direction: SplitDirection;
  first: Pane;
  second: Pane;
  ratio?: number;
}): SplitNode {
  return {
    kind: "split",
    id: randomUUID(),
    direction: input.direction,
    first: input.first,
    second: input.second,
    ratio: clampRatio(input.ratio ?? DEFAULT_RATIO),
  };
}

function buildSplitViewFromThread(input: CreateFromThreadInput): SplitView {
  const now = new Date().toISOString();
  const sourceLeaf = createLeafPane(input.sourceThreadId);
  const emptyLeaf = createLeafPane(null);
  const root = createSplitNode({
    direction: "horizontal",
    first: sourceLeaf,
    second: emptyLeaf,
  });
  return {
    id: randomUUID(),
    sourceThreadId: input.sourceThreadId,
    ownerFolderId: input.ownerFolderId,
    root,
    focusedPaneId: emptyLeaf.id,
    createdAt: now,
    updatedAt: now,
  };
}

function buildSplitViewFromDrop(
  input: CreateFromDropInput,
  existing?: Pick<SplitView, "id" | "createdAt"> | null,
): SplitView {
  const now = new Date().toISOString();
  const sourceLeaf = createLeafPane(input.sourceThreadId);
  const droppedLeaf = createLeafPane(input.droppedThreadId);
  const root = createSplitNode(
    input.side === "first"
      ? { direction: input.direction, first: droppedLeaf, second: sourceLeaf }
      : { direction: input.direction, first: sourceLeaf, second: droppedLeaf },
  );
  return {
    id: existing?.id ?? randomUUID(),
    sourceThreadId: input.sourceThreadId,
    ownerFolderId: input.ownerFolderId,
    root,
    focusedPaneId: droppedLeaf.id,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function resolveUpdatedAt(): string {
  return new Date().toISOString();
}

type SplitViewStoreState = Pick<SplitViewStore, "splitViewsById" | "splitViewIdBySourceThreadId">;

function updateSplitView(
  state: SplitViewStoreState,
  splitViewId: SplitViewId,
  updater: (splitView: SplitView) => SplitView,
): SplitViewStoreState {
  const existing = state.splitViewsById[splitViewId];
  if (!existing) return state;
  const updated = updater(existing);
  if (updated === existing) return state;
  return {
    ...state,
    splitViewsById: {
      ...state.splitViewsById,
      [splitViewId]: updated,
    },
  };
}

// Re-anchor only to threads that are not already the source of another split view.
function resolveNextSourceThreadId(input: {
  root: Pane;
  splitViewId: SplitViewId;
  splitViewIdBySourceThreadId: Record<string, SplitViewId | undefined>;
}): ThreadId | null {
  for (const leaf of collectLeaves(input.root)) {
    if (!leaf.threadId) continue;
    const existingSourceSplitId = input.splitViewIdBySourceThreadId[leaf.threadId];
    if (!existingSourceSplitId || existingSourceSplitId === input.splitViewId) {
      return leaf.threadId;
    }
  }
  return null;
}

// --- selectors ---

// Returns the threadId of the focused leaf, falling back to the first non-empty leaf when the
// focused pane is empty (so the UI never shows an "empty" thread when something is open elsewhere).
export function resolveSplitViewFocusedThreadId(splitView: SplitView): ThreadId | null {
  const focused = findLeafPaneById(splitView.root, splitView.focusedPaneId);
  if (focused?.threadId) {
    return focused.threadId;
  }
  for (const leaf of collectLeaves(splitView.root)) {
    if (leaf.threadId) return leaf.threadId;
  }
  return null;
}

// Strict variant: returns the focused leaf's threadId without any fallback (used for routing handoff).
export function resolveSplitViewFocusedPaneThreadId(splitView: SplitView): ThreadId | null {
  return findLeafPaneById(splitView.root, splitView.focusedPaneId)?.threadId ?? null;
}

export function resolveSplitViewThreadIds(splitView: SplitView): ThreadId[] {
  const ids = collectLeaves(splitView.root)
    .map((leaf) => leaf.threadId)
    .filter((threadId): threadId is ThreadId => threadId !== null);
  return [...new Set(ids)];
}

export function resolveSplitViewPaneIdForThread(
  splitView: SplitView,
  threadId: ThreadId | null,
): PaneId | null {
  if (!threadId) return null;
  for (const leaf of collectLeaves(splitView.root)) {
    if (leaf.threadId === threadId) return leaf.id;
  }
  return null;
}

export function selectSplitView(splitViewId: SplitViewId | null) {
  return (store: SplitViewStore) =>
    splitViewId ? (store.splitViewsById[splitViewId] ?? null) : null;
}

// Deterministic membership lookup: restore only if a thread has one clear split,
// or if it is the source thread of one split. Ambiguous non-source membership
// falls back to single-chat instead of guessing by recency.
export function resolvePreferredSplitViewIdForThread(input: {
  splitViewsById: Record<SplitViewId, SplitView | undefined>;
  splitViewIdBySourceThreadId: Record<string, SplitViewId | undefined>;
  threadId: ThreadId | null;
}): SplitViewId | null {
  if (!input.threadId) {
    return null;
  }

  const matchingSplitViews = Object.values(input.splitViewsById)
    .filter((splitView): splitView is SplitView => splitView !== undefined)
    .filter((splitView) =>
      collectLeaves(splitView.root).some((leaf) => leaf.threadId === input.threadId),
    );

  const sourceSplitViewId = input.splitViewIdBySourceThreadId[input.threadId] ?? null;
  if (
    sourceSplitViewId &&
    matchingSplitViews.some((splitView) => splitView.id === sourceSplitViewId)
  ) {
    return sourceSplitViewId;
  }

  const onlyMatchingSplitView = matchingSplitViews.length === 1 ? matchingSplitViews[0] : null;
  return onlyMatchingSplitView?.id ?? null;
}

// --- store ---

export const useSplitViewStore = create<SplitViewStore>()(
  persist(
    (set, get) => ({
      hasHydrated: false,
      splitViewsById: {},
      splitViewIdBySourceThreadId: {},
      setHasHydrated: (hasHydrated) => set({ hasHydrated }),
      createFromThread: (input) => {
        const existingId = get().splitViewIdBySourceThreadId[input.sourceThreadId] ?? null;
        if (existingId) {
          return existingId;
        }

        const splitView = buildSplitViewFromThread(input);
        set((state) => ({
          splitViewsById: {
            ...state.splitViewsById,
            [splitView.id]: splitView,
          },
          splitViewIdBySourceThreadId: {
            ...state.splitViewIdBySourceThreadId,
            [input.sourceThreadId]: splitView.id,
          },
        }));
        return splitView.id;
      },
      createFromDrop: (input) => {
        const existingId = get().splitViewIdBySourceThreadId[input.sourceThreadId] ?? null;
        const existing = existingId ? (get().splitViewsById[existingId] ?? null) : null;
        const splitView = buildSplitViewFromDrop(input, existing);
        set((state) => ({
          splitViewsById: {
            ...state.splitViewsById,
            [splitView.id]: splitView,
          },
          splitViewIdBySourceThreadId: {
            ...state.splitViewIdBySourceThreadId,
            [input.sourceThreadId]: splitView.id,
          },
        }));
        return splitView.id;
      },
      removeSplitView: (splitViewId) =>
        set((state) => {
          const existing = state.splitViewsById[splitViewId];
          if (!existing) return state;
          const nextSplitViewsById = { ...state.splitViewsById };
          const nextSplitViewIdBySourceThreadId = { ...state.splitViewIdBySourceThreadId };
          delete nextSplitViewsById[splitViewId];
          delete nextSplitViewIdBySourceThreadId[existing.sourceThreadId];
          return {
            splitViewsById: nextSplitViewsById,
            splitViewIdBySourceThreadId: nextSplitViewIdBySourceThreadId,
          };
        }),
      replacePaneThread: (splitViewId, paneId, threadId) =>
        set((state) => {
          const existing = state.splitViewsById[splitViewId];
          if (!existing) return state;
          let nextSourceThreadId: ThreadId | null = existing.sourceThreadId;
          let shouldRemoveSplitView = false;
          const nextState = updateSplitView(state, splitViewId, (splitView) => {
            const leaf = findLeafPaneById(splitView.root, paneId);
            if (!leaf) return splitView;
            if (leaf.threadId === threadId) return splitView;
            const nextLeaf: LeafPane = { ...leaf, threadId };
            const nextRoot = replacePaneInTree(splitView.root, paneId, nextLeaf);
            const hasAnyThread = collectLeaves(nextRoot).some(
              (nextLeaf) => nextLeaf.threadId !== null,
            );
            if (!hasAnyThread) {
              shouldRemoveSplitView = true;
            }
            if (leaf.threadId === splitView.sourceThreadId) {
              nextSourceThreadId = resolveNextSourceThreadId({
                root: nextRoot,
                splitViewId,
                splitViewIdBySourceThreadId: state.splitViewIdBySourceThreadId,
              });
              if (nextSourceThreadId === null) {
                shouldRemoveSplitView = true;
              }
            }
            return {
              ...splitView,
              sourceThreadId: nextSourceThreadId ?? splitView.sourceThreadId,
              root: nextRoot,
              updatedAt: resolveUpdatedAt(),
            };
          });
          if (nextState === state) return state;

          if (shouldRemoveSplitView) {
            const nextSplitViewsById = { ...nextState.splitViewsById };
            const nextSplitViewIdBySourceThreadId = { ...nextState.splitViewIdBySourceThreadId };
            delete nextSplitViewsById[splitViewId];
            if (nextSplitViewIdBySourceThreadId[existing.sourceThreadId] === splitViewId) {
              delete nextSplitViewIdBySourceThreadId[existing.sourceThreadId];
            }
            return {
              splitViewsById: nextSplitViewsById,
              splitViewIdBySourceThreadId: nextSplitViewIdBySourceThreadId,
            };
          }

          const updated = nextState.splitViewsById[splitViewId];
          if (
            !updated ||
            nextSourceThreadId === null ||
            nextSourceThreadId === existing.sourceThreadId
          ) {
            return nextState;
          }

          const nextSplitViewIdBySourceThreadId = { ...nextState.splitViewIdBySourceThreadId };
          if (nextSplitViewIdBySourceThreadId[existing.sourceThreadId] === splitViewId) {
            delete nextSplitViewIdBySourceThreadId[existing.sourceThreadId];
          }
          nextSplitViewIdBySourceThreadId[nextSourceThreadId] = splitViewId;
          return {
            ...nextState,
            splitViewIdBySourceThreadId: nextSplitViewIdBySourceThreadId,
          };
        }),
      dropThreadOnPane: ({ splitViewId, targetPaneId, direction, side, threadId }) => {
        const stateBefore = get();
        const splitView = stateBefore.splitViewsById[splitViewId];
        if (!splitView) return false;
        const targetLeaf = findLeafPaneById(splitView.root, targetPaneId);
        if (!targetLeaf) return false;
        if (collectLeaves(splitView.root).some((leaf) => leaf.threadId === threadId)) {
          return false;
        }
        if (!canSubdividePane(splitView.root, targetPaneId, direction)) {
          return false;
        }

        const newLeaf = createLeafPane(threadId);
        const newSplit = createSplitNode(
          side === "first"
            ? { direction, first: newLeaf, second: targetLeaf }
            : { direction, first: targetLeaf, second: newLeaf },
        );

        set((state) =>
          updateSplitView(state, splitViewId, (current) => ({
            ...current,
            root: replacePaneInTree(current.root, targetPaneId, newSplit),
            focusedPaneId: newLeaf.id,
            updatedAt: resolveUpdatedAt(),
          })),
        );
        return true;
      },
      removePaneFromSplitView: ({ splitViewId, paneId }) => {
        const stateBefore = get();
        const splitView = stateBefore.splitViewsById[splitViewId];
        if (!splitView) return false;
        const targetLeaf = findLeafPaneById(splitView.root, paneId);
        if (!targetLeaf) return false;

        set((state) => {
          const current = state.splitViewsById[splitViewId];
          if (!current) return state;
          const currentTargetLeaf = findLeafPaneById(current.root, paneId);
          if (!currentTargetLeaf) return state;

          const result = removeLeafByPaneId(current.root, paneId);
          if (result.removedLeafIds.length === 0) return state;
          const nextSplitViewsById = { ...state.splitViewsById };
          const nextSplitViewIdBySourceThreadId = { ...state.splitViewIdBySourceThreadId };

          if (current.sourceThreadId === currentTargetLeaf.threadId) {
            delete nextSplitViewIdBySourceThreadId[current.sourceThreadId];
          }

          if (!result.nextRoot) {
            delete nextSplitViewsById[splitViewId];
            delete nextSplitViewIdBySourceThreadId[current.sourceThreadId];
            return {
              splitViewsById: nextSplitViewsById,
              splitViewIdBySourceThreadId: nextSplitViewIdBySourceThreadId,
            };
          }

          const hasAnyThread = collectLeaves(result.nextRoot).some(
            (leaf) => leaf.threadId !== null,
          );
          if (!hasAnyThread) {
            delete nextSplitViewsById[splitViewId];
            delete nextSplitViewIdBySourceThreadId[current.sourceThreadId];
            return {
              splitViewsById: nextSplitViewsById,
              splitViewIdBySourceThreadId: nextSplitViewIdBySourceThreadId,
            };
          }

          const nextSourceThreadId =
            current.sourceThreadId === currentTargetLeaf.threadId
              ? resolveNextSourceThreadId({
                  root: result.nextRoot,
                  splitViewId,
                  splitViewIdBySourceThreadId: nextSplitViewIdBySourceThreadId,
                })
              : current.sourceThreadId;
          if (!nextSourceThreadId) {
            delete nextSplitViewsById[splitViewId];
            return {
              splitViewsById: nextSplitViewsById,
              splitViewIdBySourceThreadId: nextSplitViewIdBySourceThreadId,
            };
          }
          if (nextSourceThreadId !== current.sourceThreadId) {
            nextSplitViewIdBySourceThreadId[nextSourceThreadId] = splitViewId;
          }

          const focusedStillPresent = !result.removedLeafIds.includes(current.focusedPaneId);
          nextSplitViewsById[splitViewId] = {
            ...current,
            sourceThreadId: nextSourceThreadId,
            root: result.nextRoot,
            focusedPaneId: focusedStillPresent
              ? current.focusedPaneId
              : resolveDefaultFocusLeafId(result.nextRoot),
            updatedAt: resolveUpdatedAt(),
          };
          return {
            splitViewsById: nextSplitViewsById,
            splitViewIdBySourceThreadId: nextSplitViewIdBySourceThreadId,
          };
        });
        return true;
      },
      setFocusedPane: (splitViewId, paneId) =>
        set((state) =>
          updateSplitView(state, splitViewId, (splitView) => {
            if (splitView.focusedPaneId === paneId) return splitView;
            if (!findLeafPaneById(splitView.root, paneId)) return splitView;
            return {
              ...splitView,
              focusedPaneId: paneId,
              updatedAt: resolveUpdatedAt(),
            };
          }),
        ),
      setRatioForNode: (splitViewId, splitNodeId, ratio) =>
        set((state) =>
          updateSplitView(state, splitViewId, (splitView) => {
            const node = findSplitNodeById(splitView.root, splitNodeId);
            if (!node) return splitView;
            const nextRatio = clampRatio(ratio);
            if (node.ratio === nextRatio) return splitView;
            const nextNode: SplitNode = { ...node, ratio: nextRatio };
            return {
              ...splitView,
              root: replacePaneInTree(splitView.root, splitNodeId, nextNode),
              updatedAt: resolveUpdatedAt(),
            };
          }),
        ),
      removeThreadFromSplitViews: (threadId) =>
        set((state) => {
          let didChange = false;
          const nextSplitViewsById = { ...state.splitViewsById };
          const nextSplitViewIdBySourceThreadId = { ...state.splitViewIdBySourceThreadId };

          for (const [splitViewId, splitView] of Object.entries(state.splitViewsById)) {
            if (!splitView) {
              continue;
            }
            const result = removeLeafByThreadIdInTree(splitView.root, threadId);
            if (result.removedLeafIds.length === 0) {
              continue;
            }

            didChange = true;
            if (result.nextRoot === null) {
              delete nextSplitViewsById[splitViewId];
              delete nextSplitViewIdBySourceThreadId[splitView.sourceThreadId];
              continue;
            }
            if (!collectLeaves(result.nextRoot).some((leaf) => leaf.threadId !== null)) {
              delete nextSplitViewsById[splitViewId];
              delete nextSplitViewIdBySourceThreadId[splitView.sourceThreadId];
              continue;
            }

            const focusedStillPresent = !result.removedLeafIds.includes(splitView.focusedPaneId);
            const nextFocusedPaneId = focusedStillPresent
              ? splitView.focusedPaneId
              : resolveDefaultFocusLeafId(result.nextRoot);
            const nextSourceThreadId =
              splitView.sourceThreadId === threadId
                ? resolveNextSourceThreadId({
                    root: result.nextRoot,
                    splitViewId,
                    splitViewIdBySourceThreadId: nextSplitViewIdBySourceThreadId,
                  })
                : splitView.sourceThreadId;

            if (splitView.sourceThreadId === threadId) {
              delete nextSplitViewIdBySourceThreadId[splitView.sourceThreadId];
            }
            if (!nextSourceThreadId) {
              delete nextSplitViewsById[splitViewId];
              continue;
            }
            if (nextSourceThreadId !== splitView.sourceThreadId) {
              nextSplitViewIdBySourceThreadId[nextSourceThreadId] = splitViewId;
            }

            nextSplitViewsById[splitViewId] = {
              ...splitView,
              sourceThreadId: nextSourceThreadId,
              root: result.nextRoot,
              focusedPaneId: nextFocusedPaneId,
              updatedAt: resolveUpdatedAt(),
            };
          }

          if (!didChange) {
            return state;
          }

          return {
            splitViewsById: nextSplitViewsById,
            splitViewIdBySourceThreadId: nextSplitViewIdBySourceThreadId,
          };
        }),
    }),
    {
      name: SPLIT_VIEW_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        splitViewsById: state.splitViewsById,
        splitViewIdBySourceThreadId: state.splitViewIdBySourceThreadId,
      }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...(persistedState as Partial<SplitViewStoreState>),
        hasHydrated: currentState.hasHydrated,
      }),
      onRehydrateStorage: () => {
        return (state) => {
          state?.setHasHydrated(true);
        };
      },
    },
  ),
);
