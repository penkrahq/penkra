// FILE: useSpacesController.ts
// Purpose: All Space selection, editing, deletion, and assignment behavior behind the sidebar.
// Layer: Sidebar controller hook
// Why: Sidebar.tsx is the largest component in the app; the Spaces feature is a
//      self-contained unit of handlers, dialog state, and sync effects. One seam here
//      (inputs in, handlers out) keeps it reviewable instead of interleaved through an
//      8k-line component.

import type { FolderId, SpaceId, ThreadId } from "@penkra/contracts";
import { useNavigate } from "@tanstack/react-router";
import { startTransition, useCallback, useEffect, useMemo, useState } from "react";

import type { SidebarThreadSortOrder } from "../appSettings";
import {
  archiveSpace,
  createSpace,
  deleteSpace,
  isOrdinarySpaceProject,
  moveProjectToSpace,
  reorderSpaces,
  updateSpace,
} from "../lib/spaces";
import { readNativeApi } from "../nativeApi";
import { useSpacesUiStore } from "../spacesUiStore";
import { useStore } from "../store";
import type { Project, SidebarThreadSummary, Space } from "../types";
import { toSpaceIconName } from "../lib/spaceGrouping";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { sortThreadsForSidebar } from "./Sidebar.logic";
import { useRouteSpaceSync } from "./useRouteSpaceSync";
import { toastManager } from "./ui/toast";

type SpaceEditorState =
  | { mode: "create"; folderIdAfterCreate: FolderId | null }
  | { mode: "edit"; spaceId: SpaceId };

type SpaceEditorValue = {
  name: string;
  icon: string;
};

function requireAssignedSpaceId(spaceId: SpaceId | null | undefined, subject: string): SpaceId {
  if (spaceId == null) throw new Error(`${subject} is missing its required Space assignment.`);
  return spaceId;
}

export function useSpacesController(input: {
  /** Ordinary (space-assignable) folders; computed by Sidebar because its own memos need it too. */
  ordinarySpaceFolders: readonly Project[];
  projectById: ReadonlyMap<FolderId, Project>;
  sidebarThreads: readonly SidebarThreadSummary[];
  sidebarThreadSortOrder: SidebarThreadSortOrder;
  routeThreadId: ThreadId | null;
  activeRouteProject: Project | null;
  activeRouteFolderId: FolderId | null;
  activateThreadFromSidebarIntent: (threadId: ThreadId) => void;
}) {
  const {
    activateThreadFromSidebarIntent,
    activeRouteProject,
    activeRouteFolderId,
    ordinarySpaceFolders,
    projectById,
    routeThreadId,
    sidebarThreadSortOrder,
    sidebarThreads,
  } = input;

  const navigate = useNavigate();
  const spaces = useStore((store) => store.spaces);
  const reorderSpacesLocally = useStore((store) => store.reorderSpacesLocally);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const shellSnapshotSequence = useStore((store) => store.shellSnapshotSequence ?? 0);
  const activeSpaceId = useSpacesUiStore((store) => store.activeSpaceId);
  const setActiveSpaceId = useSpacesUiStore((store) => store.setActiveSpaceId);
  const setOptimisticActiveSpaceId = useSpacesUiStore((store) => store.setOptimisticActiveSpaceId);
  const rememberSpaceThread = useSpacesUiStore((store) => store.rememberThread);
  const getLastSpaceThreadId = useSpacesUiStore((store) => store.getLastThreadId);
  const reconcileSpacesUi = useSpacesUiStore((store) => store.reconcile);
  const hydrateSpacesUi = useSpacesUiStore((store) => store.hydrateFromServer);
  const homeDir = useWorkspacePathsStore((store) => store.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((store) => store.chatWorkspaceRoot);
  const workspacePaths = useMemo(
    () => ({ homeDir, chatWorkspaceRoot }),
    [chatWorkspaceRoot, homeDir],
  );

  const routeSpaceProject = activeRouteProject;
  const routeThread = routeThreadId
    ? (sidebarThreads.find((thread) => thread.id === routeThreadId) ?? null)
    : null;
  const routeSpaceContext = isOrdinarySpaceProject(routeSpaceProject, workspacePaths)
    ? {
        folderId: routeSpaceProject.id,
        spaceId: requireAssignedSpaceId(
          routeSpaceProject.spaceId,
          `Folder '${routeSpaceProject.id}'`,
        ),
      }
    : routeThread?.spaceId != null
      ? { folderId: routeThread.folderId, spaceId: routeThread.spaceId }
      : null;
  const routeSpaceFolderId = routeSpaceContext?.folderId ?? null;
  const routeSpaceId = routeSpaceContext ? routeSpaceContext.spaceId : undefined;

  const [spaceEditorState, setSpaceEditorState] = useState<SpaceEditorState | null>(null);

  useEffect(() => {
    void hydrateSpacesUi().catch(() => {
      // Keep the in-memory selection usable; a later mount can retry hydration.
    });
  }, [hydrateSpacesUi]);

  useEffect(() => {
    if (!threadsHydrated) return;
    reconcileSpacesUi({
      activeSpaceIds: new Set(spaces.map((space) => space.id)),
      snapshotSequence: shellSnapshotSequence,
      projectSpaceById: new Map(
        ordinarySpaceFolders.map(
          (project) =>
            [
              project.id,
              requireAssignedSpaceId(project.spaceId, `Folder '${project.id}'`),
            ] as const,
        ),
      ),
      threadProjectById: new Map(
        sidebarThreads
          .filter((thread) => thread.archivedAt == null)
          .map((thread) => [thread.id, thread.folderId] as const),
      ),
      threadSpaceById: new Map(
        sidebarThreads
          .filter((thread) => thread.archivedAt == null && thread.spaceId != null)
          .map((thread) => [thread.id, thread.spaceId as SpaceId] as const),
      ),
    });
  }, [
    ordinarySpaceFolders,
    reconcileSpacesUi,
    shellSnapshotSequence,
    sidebarThreads,
    spaces,
    threadsHydrated,
  ]);

  useRouteSpaceSync({
    routeFolderId: routeSpaceFolderId,
    routeSpaceId,
    routeThreadId,
  });

  const selectSpaceForNavigation = useCallback(
    (spaceId: SpaceId) => {
      setActiveSpaceId(spaceId);
    },
    [setActiveSpaceId],
  );

  // Bookmark the context being left so returning to that space restores it.
  const rememberDepartingSpaceContext = useCallback(() => {
    const currentRouteSpaceProject = activeRouteProject;
    if (!routeThreadId) return;
    if (isOrdinarySpaceProject(currentRouteSpaceProject, workspacePaths)) {
      rememberSpaceThread(
        requireAssignedSpaceId(
          currentRouteSpaceProject.spaceId,
          `Folder '${currentRouteSpaceProject.id}'`,
        ),
        routeThreadId,
      );
      return;
    }
    const currentThread = sidebarThreads.find((thread) => thread.id === routeThreadId);
    if (currentThread?.spaceId != null) {
      rememberSpaceThread(currentThread.spaceId, routeThreadId);
    }
  }, [activeRouteProject, rememberSpaceThread, routeThreadId, sidebarThreads, workspacePaths]);

  /**
   * Switch spaces without restoring the target space's last context. Used when the
   * caller is about to navigate itself (creating a project files it into the target
   * space and then opens its first thread) — the restore navigation would race it.
   */
  const handleSelectSpaceForIncomingProject = useCallback(
    (spaceId: SpaceId) => {
      // Read the live value so an async create flow can roll back a provisional
      // selection with the same callback instance it used to select it.
      if (spaceId === useSpacesUiStore.getState().activeSpaceId) return;
      rememberDepartingSpaceContext();
      selectSpaceForNavigation(spaceId);
    },
    [rememberDepartingSpaceContext, selectSpaceForNavigation],
  );

  const handleSelectSpace = useCallback(
    (spaceId: SpaceId) => {
      if (spaceId === activeSpaceId) return;

      rememberDepartingSpaceContext();

      selectSpaceForNavigation(spaceId);

      const availableThreads = sidebarThreads.filter((thread) => {
        if (thread.archivedAt != null) return false;
        const project = projectById.get(thread.folderId);
        if (thread.spaceId != null) return thread.spaceId === spaceId;
        return isOrdinarySpaceProject(project, workspacePaths) && project.spaceId === spaceId;
      });
      const rememberedThreadId = getLastSpaceThreadId(spaceId);
      const rememberedThread = rememberedThreadId
        ? availableThreads.find((thread) => thread.id === rememberedThreadId)
        : null;
      if (rememberedThread) {
        activateThreadFromSidebarIntent(rememberedThread.id);
        return;
      }

      const targetThread =
        sortThreadsForSidebar(availableThreads, sidebarThreadSortOrder)[0] ?? null;
      if (targetThread) {
        activateThreadFromSidebarIntent(targetThread.id);
        return;
      }

      startTransition(() => {
        void navigate({ to: "/" });
      });
    },
    [
      activateThreadFromSidebarIntent,
      activeSpaceId,
      getLastSpaceThreadId,
      navigate,
      projectById,
      rememberDepartingSpaceContext,
      selectSpaceForNavigation,
      sidebarThreadSortOrder,
      sidebarThreads,
      workspacePaths,
    ],
  );

  const handleSpaceEditorSubmit = useCallback(
    async (value: SpaceEditorValue) => {
      const api = readNativeApi();
      if (!api || !spaceEditorState) {
        throw new Error("The app server is unavailable.");
      }

      if (spaceEditorState.mode === "edit") {
        // Only actual changes are sent, so an icon-only edit cannot collide with a
        // concurrent rename; saving with nothing changed is a plain close, not a
        // command — the server rejects no-op metadata updates.
        const currentSpace = spaces.find((space) => space.id === spaceEditorState.spaceId);
        const nextName = currentSpace?.name === value.name ? undefined : value.name;
        const submittedIcon = toSpaceIconName(value.icon);
        const nextIcon = currentSpace?.icon === submittedIcon ? undefined : submittedIcon;
        if (nextName === undefined && nextIcon === undefined) {
          return;
        }
        await updateSpace({
          api,
          spaceId: spaceEditorState.spaceId,
          name: nextName,
          icon: nextIcon,
        });
        return;
      }

      const submittedIcon = toSpaceIconName(value.icon);
      let createResult: Awaited<ReturnType<typeof createSpace>>;
      try {
        createResult = await createSpace({
          api,
          name: value.name,
          icon: submittedIcon,
        });
      } catch (error) {
        // A duplicate-name rejection can reveal that this renderer missed an earlier
        // committed create. Hydrate that Space immediately while preserving the concise
        // invariant detail in the inline editor.
        try {
          const snapshot = await api.orchestration.getShellSnapshot();
          useStore.getState().syncServerShellSnapshot(snapshot);
        } catch {
          // Preserve the original command failure when recovery cannot reach the shell.
        }
        throw error;
      }
      const { spaceId, sequence, createdAt } = createResult;
      // The shell stream is the normal update path, but a command can finish while this
      // renderer is reconnecting and its live Space upsert can be missed. Reconcile the
      // committed create from the authoritative shell before closing the editor so the
      // new Space cannot remain invisible until the next app launch.
      let reconciledFromShell = false;
      try {
        const snapshot = await api.orchestration.getShellSnapshot();
        if (
          snapshot.snapshotSequence >= sequence &&
          snapshot.spaces.some((space) => space.id === spaceId)
        ) {
          useStore.getState().syncServerShellSnapshot(snapshot);
          reconciledFromShell = true;
        }
      } catch {
        // The command is already committed. Keep the successful create and let the live
        // stream (or its reconnect snapshot) perform the eventual reconciliation.
      }
      if (
        !reconciledFromShell &&
        !useStore.getState().spaces.some((space) => space.id === spaceId)
      ) {
        useStore.getState().applyShellEvent({
          kind: "space-upserted",
          sequence,
          space: {
            id: spaceId,
            name: value.name,
            icon: submittedIcon,
            sortOrder: spaces.reduce((next, space) => Math.max(next, space.sortOrder + 1), 0),
            createdAt,
            updatedAt: createdAt,
          },
        });
      }
      const folderId = spaceEditorState.folderIdAfterCreate;
      if (folderId) {
        try {
          await moveProjectToSpace({ api, folderId, spaceId });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: `${value.name} was created, but the folder was not moved`,
            description: error instanceof Error ? error.message : "Try moving the folder again.",
          });
          return;
        }

        if (activeRouteFolderId === folderId) {
          selectSpaceForNavigation(spaceId);
          setOptimisticActiveSpaceId(spaceId, sequence);
        }
        return;
      }

      handleSelectSpace(spaceId);
      setOptimisticActiveSpaceId(spaceId, sequence);
    },
    [
      activeRouteFolderId,
      handleSelectSpace,
      selectSpaceForNavigation,
      setOptimisticActiveSpaceId,
      spaceEditorState,
      spaces,
    ],
  );

  const handleDeleteSpace = useCallback(
    async (spaceId: SpaceId) => {
      const api = readNativeApi();
      const space = spaces.find((candidate) => candidate.id === spaceId);
      if (!api || !space) return;
      const folderCount = ordinarySpaceFolders.filter(
        (project) => project.spaceId === spaceId,
      ).length;
      if (folderCount > 0) {
        toastManager.add({
          type: "error",
          title: "Move folders before deleting this space",
          description: `${folderCount} folder${folderCount === 1 ? " is" : "s are"} still assigned to ${space.name}.`,
        });
        return;
      }
      const confirmed = await api.dialogs.confirm(`Delete “${space.name}”?`);
      if (!confirmed) return;

      try {
        await deleteSpace({ api, spaceId });
        if (activeSpaceId === spaceId) {
          const nextSpace = spaces.find((candidate) => candidate.id !== spaceId);
          if (!nextSpace) throw new Error("At least one active Space must remain.");
          selectSpaceForNavigation(nextSpace.id);
          if (!isOrdinarySpaceProject(activeRouteProject, workspacePaths)) {
            void navigate({ to: "/" });
          }
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Unable to delete space",
          description: error instanceof Error ? error.message : "Try again.",
        });
      }
    },
    [
      activeRouteProject,
      activeSpaceId,
      navigate,
      ordinarySpaceFolders,
      selectSpaceForNavigation,
      spaces,
      workspacePaths,
    ],
  );

  const handleArchiveSpace = useCallback(
    async (spaceId: SpaceId) => {
      const api = readNativeApi();
      const space = spaces.find((candidate) => candidate.id === spaceId);
      if (!api || !space) return;

      try {
        await archiveSpace({ api, spaceId });

        if (activeSpaceId === spaceId || routeSpaceId === spaceId) {
          const nextSpace = spaces.find((candidate) => candidate.id !== spaceId);
          if (!nextSpace) throw new Error("At least one active Space must remain.");
          selectSpaceForNavigation(nextSpace.id);
        }
        if (routeSpaceId === spaceId) {
          void navigate({ to: "/" });
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Unable to archive space",
          description: error instanceof Error ? error.message : "Try again.",
        });
      }
    },
    [activeSpaceId, navigate, routeSpaceId, selectSpaceForNavigation, spaces],
  );

  const handleRenameSpace = useCallback(async (space: Space, name: string) => {
    const api = readNativeApi();
    if (!api || space.name === name) return;
    try {
      await updateSpace({ api, spaceId: space.id, name });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to rename space",
        description: error instanceof Error ? error.message : "Try again.",
      });
    }
  }, []);

  const handleReorderSpaces = useCallback(
    (orderedSpaceIds: ReadonlyArray<SpaceId>, movedSpaceId: SpaceId) => {
      const api = readNativeApi();
      if (!api) return;
      reorderSpacesLocally(orderedSpaceIds);
      void reorderSpaces({ api, movedSpaceId, orderedSpaceIds }).catch(async (error) => {
        try {
          // A transport error can arrive after the command committed. Re-read the authoritative
          // shell instead of blindly rolling back a reorder the server may already have stored.
          const snapshot = await api.orchestration.getShellSnapshot();
          useStore.getState().syncServerShellSnapshot(snapshot);
          const confirmedSpaceIds = snapshot.spaces.map((space) => space.id);
          if (
            confirmedSpaceIds.length === orderedSpaceIds.length &&
            confirmedSpaceIds.every((spaceId, index) => spaceId === orderedSpaceIds[index])
          ) {
            return;
          }
        } catch {
          // Keep the optimistic order when authority cannot be reached; the next shell snapshot
          // will reconcile it without risking a false rollback after a successful commit.
        }
        toastManager.add({
          type: "error",
          title: "Unable to confirm space order",
          description: error instanceof Error ? error.message : "Try again.",
        });
      });
    },
    [reorderSpacesLocally],
  );

  const handleMoveProjectToSpace = useCallback(
    async (folderId: FolderId, spaceId: SpaceId) => {
      const api = readNativeApi();
      const project = projectById.get(folderId);
      if (!api || !project || (project.spaceId ?? null) === spaceId) return;
      try {
        await moveProjectToSpace({ api, folderId, spaceId });
        if (activeRouteFolderId === folderId) {
          selectSpaceForNavigation(spaceId);
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Unable to move folder",
          description: error instanceof Error ? error.message : "Try again.",
        });
      }
    },
    [activeRouteFolderId, projectById, selectSpaceForNavigation],
  );

  const openSpaceCreator = useCallback((folderIdAfterCreate: FolderId | null = null) => {
    setSpaceEditorState({ mode: "create", folderIdAfterCreate });
  }, []);
  const openSpaceEditor = useCallback((spaceId: SpaceId) => {
    setSpaceEditorState({ mode: "edit", spaceId });
  }, []);
  const closeSpaceEditor = useCallback(() => setSpaceEditorState(null), []);

  const activeSpace: Space | null = activeSpaceId
    ? (spaces.find((space) => space.id === activeSpaceId) ?? null)
    : null;
  const editedSpace: Space | null =
    spaceEditorState?.mode === "edit"
      ? (spaces.find((space) => space.id === spaceEditorState.spaceId) ?? null)
      : null;
  const spaceEditorExistingNames = spaces
    .filter((space) => space.id !== editedSpace?.id)
    .map((space) => space.name);

  return {
    activeSpace,
    editedSpace,
    spaceEditorOpen:
      spaceEditorState?.mode === "create" ||
      (spaceEditorState?.mode === "edit" && editedSpace !== null),
    spaceEditorMode: spaceEditorState?.mode ?? ("create" as const),
    spaceEditorExistingNames,
    openSpaceCreator,
    openSpaceEditor,
    closeSpaceEditor,
    handleSelectSpace,
    handleSelectSpaceForIncomingProject,
    handleReorderSpaces,
    handleRenameSpace,
    handleArchiveSpace,
    handleDeleteSpace,
    handleMoveProjectToSpace,
    handleSpaceEditorSubmit,
  };
}
