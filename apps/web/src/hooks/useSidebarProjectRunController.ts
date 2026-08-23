// FILE: useSidebarProjectRunController.ts
// Purpose: Owns Sidebar project-run discovery, server attribution, dialog state, and lifecycle actions.
// Layer: Web Sidebar controller hook
// Exports: useSidebarProjectRunController

import {
  type ProjectDiscoveredScriptTarget,
  type FolderId,
  type ServerLocalServerProcess,
} from "@penkra/contracts";
import { localServerAddressLabel, localServerMatchesRun } from "@penkra/shared/localServers";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { findDeepestWorkspaceRootMatch } from "../components/Sidebar.logic";
import { toastManager } from "../components/ui/toast";
import { projectDiscoverScriptsQueryOptions } from "../lib/projectReactQuery";
import { serverQueryKeys, sidebarLocalServersQueryOptions } from "../lib/serverReactQuery";
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useProjectRunStore, type ProjectRunState } from "../projectRunStore";
import {
  selectPrimaryProjectRunCommand,
  upsertProjectRunCommandScripts,
} from "../projectRunTargets";
import { projectScriptRuntimeEnv } from "../projectScripts";
import type { Project } from "../types";

export function firstLocalServerUrl(server: ServerLocalServerProcess): string | null {
  return server.addresses.find((address) => address.url)?.url ?? null;
}

function findTrackedProjectRunServer(
  run: ProjectRunState | null | undefined,
  servers: readonly ServerLocalServerProcess[],
): ServerLocalServerProcess | null {
  if (!run) {
    return null;
  }
  return servers.find((server) => localServerMatchesRun(server, run)) ?? null;
}

export function useSidebarProjectRunController(input: {
  readonly folders: readonly Project[];
  readonly projectById: ReadonlyMap<FolderId, Project>;
  readonly homeDir: string | null;
  readonly chatWorkspaceRoot: string | null;
}) {
  const queryClient = useQueryClient();
  const projectRunsByFolderId = useProjectRunStore((state) => state.runsByFolderId);
  const storeUpsertProjectRun = useProjectRunStore((state) => state.upsertRun);
  const storeRemoveProjectRun = useProjectRunStore((state) => state.removeRun);
  const [dialogFolderId, setDialogFolderId] = useState<FolderId | null>(null);
  const [dialogCommandDraft, setDialogCommandDraft] = useState("");

  const runnableFolders = useMemo(() => input.folders, [input.folders]);
  const discoveryInputs = useMemo(() => {
    const byCwd = new Map<string, { cwd: string; enabled: boolean }>();
    for (const project of runnableFolders) {
      if (!project.cwd) continue;
      const enabled = project.scripts.length === 0;
      const existing = byCwd.get(project.cwd);
      if (!existing) {
        byCwd.set(project.cwd, { cwd: project.cwd, enabled });
      } else if (enabled) {
        existing.enabled = true;
      }
    }
    return [...byCwd.values()];
  }, [runnableFolders]);
  const discoveryQueries = useQueries({
    queries: discoveryInputs.map((input) =>
      projectDiscoverScriptsQueryOptions({ cwd: input.cwd, enabled: input.enabled }),
    ),
  });
  const discoveredTargetsByFolderId = useMemo(() => {
    const targetsByCwd = new Map<string, readonly ProjectDiscoveredScriptTarget[]>();
    for (let index = 0; index < discoveryInputs.length; index += 1) {
      const input = discoveryInputs[index];
      if (input) targetsByCwd.set(input.cwd, discoveryQueries[index]?.data?.targets ?? []);
    }
    const targetsByFolderId = new Map<FolderId, readonly ProjectDiscoveredScriptTarget[]>();
    for (const project of runnableFolders) {
      targetsByFolderId.set(project.id, project.cwd ? (targetsByCwd.get(project.cwd) ?? []) : []);
    }
    return targetsByFolderId;
  }, [discoveryInputs, discoveryQueries, runnableFolders]);
  const commandByFolderId = useMemo(() => {
    const commands = new Map<FolderId, ReturnType<typeof selectPrimaryProjectRunCommand>>();
    for (const project of runnableFolders) {
      commands.set(
        project.id,
        selectPrimaryProjectRunCommand({
          project,
          discoveredTargets: discoveredTargetsByFolderId.get(project.id) ?? [],
        }),
      );
    }
    return commands;
  }, [discoveredTargetsByFolderId, runnableFolders]);
  const commandByFolderIdRef = useRef(commandByFolderId);
  useEffect(() => {
    commandByFolderIdRef.current = commandByFolderId;
  }, [commandByFolderId]);

  const hasActiveProjectRun = useMemo(
    () => Object.keys(projectRunsByFolderId).length > 0,
    [projectRunsByFolderId],
  );
  const localServersQuery = useQuery(
    sidebarLocalServersQueryOptions({
      hasActiveProjectRun,
      hasFolders: runnableFolders.length > 0,
    }),
  );
  const serverByFolderId = useMemo(() => {
    const servers = localServersQuery.data?.servers ?? [];
    const serversByProject = new Map<FolderId, ServerLocalServerProcess>();

    for (const run of Object.values(projectRunsByFolderId)) {
      const server = findTrackedProjectRunServer(run, servers);
      if (server) {
        serversByProject.set(run.folderId, server);
      }
    }
    for (const server of servers) {
      if (!server.cwd) continue;
      const project = findDeepestWorkspaceRootMatch(
        runnableFolders,
        server.cwd,
        (candidate) => candidate.cwd,
      );
      if (project && !serversByProject.has(project.id)) {
        serversByProject.set(project.id, server);
      }
    }
    return serversByProject;
  }, [localServersQuery.data?.servers, projectRunsByFolderId, runnableFolders]);
  const serverByFolderIdRef = useRef(serverByFolderId);
  useEffect(() => {
    serverByFolderIdRef.current = serverByFolderId;
  }, [serverByFolderId]);

  const startProjectRun = useCallback(
    async (folderId: FolderId, commandOverride?: string) => {
      const api = readNativeApi();
      const project = input.projectById.get(folderId);
      const runCommand = commandByFolderIdRef.current.get(folderId);
      if (!api || !project || !runCommand || projectRunsByFolderId[folderId]) {
        return;
      }
      const command = commandOverride?.trim() || runCommand.command;
      const env = projectScriptRuntimeEnv({
        project: { cwd: project.cwd },
      });

      storeUpsertProjectRun({
        folderId,
        command,
        cwd: runCommand.cwd,
        pid: null,
        startedAt: new Date().toISOString(),
        status: "starting",
      });
      try {
        const { server } = await api.folders.runDevServer({
          folderId,
          command,
          cwd: runCommand.cwd,
          env,
        });
        storeUpsertProjectRun(server);
        void queryClient.invalidateQueries({ queryKey: serverQueryKeys.localServers() });
      } catch (error) {
        storeRemoveProjectRun(folderId);
        toastManager.add({
          type: "error",
          title: `Failed to run "${project.name}"`,
          description: error instanceof Error ? error.message : "Unable to start the run command.",
        });
      }
    },
    [
      input.projectById,
      projectRunsByFolderId,
      queryClient,
      storeRemoveProjectRun,
      storeUpsertProjectRun,
    ],
  );

  const stopProjectRun = useCallback(
    async (folderId: FolderId) => {
      const api = readNativeApi();
      if (!api) {
        storeRemoveProjectRun(folderId);
        return;
      }
      storeRemoveProjectRun(folderId);
      try {
        await api.folders.stopDevServer({ folderId });
      } catch (error) {
        try {
          const { servers } = await api.folders.listDevServers();
          useProjectRunStore.getState().replaceAll(servers);
        } catch {
          // The dev-server event stream remains the final reconciliation path.
        }
        toastManager.add({
          type: "error",
          title: "Failed to stop run",
          description: error instanceof Error ? error.message : "Unable to stop the dev server.",
        });
      } finally {
        void queryClient.invalidateQueries({ queryKey: serverQueryKeys.localServers() });
      }
    },
    [queryClient, storeRemoveProjectRun],
  );

  const openProjectRunServer = useCallback(async (folderId: FolderId) => {
    const api = readNativeApi();
    const server = serverByFolderIdRef.current.get(folderId);
    const url = server ? firstLocalServerUrl(server) : null;
    if (!api || !server || !url) return;
    try {
      await api.shell.openExternal(url);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Unable to open ${localServerAddressLabel(server)}`,
        description: error instanceof Error ? error.message : "Unable to open the local server.",
      });
    }
  }, []);

  const persistProjectRunCommand = useCallback(
    async (folderId: FolderId, command: string) => {
      const api = readNativeApi();
      const project = input.projectById.get(folderId);
      if (!api || !project) return;
      const nextScripts = upsertProjectRunCommandScripts({ scripts: project.scripts, command });
      if (!nextScripts) return;
      try {
        await api.orchestration.dispatchCommand({
          type: "folder.update",
          commandId: newCommandId(),
          folderId,
          scripts: nextScripts,
        });
      } catch (error) {
        console.error("Failed to save project run command", { folderId, error });
      }
    },
    [input.projectById],
  );

  const openProjectRunDialog = useCallback((folderId: FolderId) => {
    setDialogFolderId(folderId);
  }, []);
  const closeProjectRunDialog = useCallback(() => {
    setDialogFolderId(null);
  }, []);
  useEffect(() => {
    if (dialogFolderId === null) return;
    const defaultCommand = commandByFolderIdRef.current.get(dialogFolderId)?.command ?? "";
    const settle = window.setTimeout(() => {
      setDialogCommandDraft(defaultCommand);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [dialogFolderId]);
  const confirmProjectRun = useCallback(() => {
    if (!dialogFolderId) return;
    const command = dialogCommandDraft.trim();
    if (!command) return;
    setDialogFolderId(null);
    void persistProjectRunCommand(dialogFolderId, command);
    void startProjectRun(dialogFolderId, command);
  }, [dialogCommandDraft, dialogFolderId, persistProjectRunCommand, startProjectRun]);

  return {
    projectRunsByFolderId,
    projectRunServerByFolderId: serverByFolderId,
    projectRunDialogFolderId: dialogFolderId,
    projectRunDialogProject: dialogFolderId
      ? (input.projectById.get(dialogFolderId) ?? null)
      : null,
    projectRunDialogExistingRun: dialogFolderId
      ? (projectRunsByFolderId[dialogFolderId] ?? null)
      : null,
    projectRunDialogCommandDraft: dialogCommandDraft,
    setProjectRunDialogCommandDraft: setDialogCommandDraft,
    projectRunDialogCommandIsValid: dialogCommandDraft.trim().length > 0,
    openProjectRunDialog,
    closeProjectRunDialog,
    handleConfirmProjectRun: confirmProjectRun,
    handleStopProjectRun: stopProjectRun,
    handleOpenProjectRunServer: openProjectRunServer,
  } as const;
}
