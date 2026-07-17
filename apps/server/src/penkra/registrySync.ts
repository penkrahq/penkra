import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { CommandId, ProjectId, type OrchestrationProject } from "@synara/contracts";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine";
import { PenkraBackendClient, type PenkraClientRecord } from "./backendClient";
import type { PenkraRuntimeConfig } from "./config";
import { hasClientConfig, scaffoldClient, scaffoldHq } from "./scaffold";

export type RegistrySyncResult = {
  status: "disabled" | "needs-hq-auth" | "reconciled";
  clients: number;
  unknownFolders: string[];
  archivedClients: string[];
};

export function coalesceRegistryReconciliations<T>(
  reconcile: () => Promise<T>,
): () => Promise<T> {
  let running: Promise<T> | null = null;
  let rerunRequested = false;

  return () => {
    if (running) {
      rerunRequested = true;
      return running;
    }
    running = (async () => {
      try {
        let result: T;
        do {
          rerunRequested = false;
          result = await reconcile();
        } while (rerunRequested);
        return result;
      } finally {
        running = null;
      }
    })();
    return running;
  };
}

export async function reconcilePenkraRegistry(input: {
  config: PenkraRuntimeConfig | null;
  engine: OrchestrationEngineShape;
}): Promise<RegistrySyncResult> {
  if (!input.config) return emptyResult("disabled");
  const backend = await PenkraBackendClient.fromHqConfig(input.config.hqConfigPath);
  if (!backend) return emptyResult("needs-hq-auth");

  const hqWorkspace = await scaffoldHq(input.config.root);
  await ensureProject(input.engine, {
    id: "penkra-hq",
    title: "Penkra HQ",
    workspaceRoot: hqWorkspace,
    isPinned: true,
    enforcePin: true,
  });

  const clients = await backend.listClients();
  const activeClients = clients.filter((client) => client.status !== "archived");
  for (const client of activeClients) {
    const workspace = path.join(input.config.root, client.id);
    const configured = await hasClientConfig(workspace, client.id);
    const token = configured ? null : await backend.reissueClientToken(client.id);
    await scaffoldClient({
      root: input.config.root,
      endpoint: input.config.endpoint,
      client,
      token,
    });
    await ensureProject(input.engine, {
      id: `penkra-client-${client.id}`,
      title: client.displayName,
      workspaceRoot: workspace,
      isPinned: false,
      enforcePin: false,
    });
  }

  return {
    status: "reconciled",
    clients: activeClients.length,
    unknownFolders: await findUnknownFolders(input.config.root, clients),
    archivedClients: clients
      .filter((client) => client.status === "archived")
      .map((client) => client.id),
  };
}

async function ensureProject(
  engine: OrchestrationEngineShape,
  desired: {
    id: string;
    title: string;
    workspaceRoot: string;
    isPinned: boolean;
    enforcePin: boolean;
  },
): Promise<void> {
  const readModel = await Effect.runPromise(engine.getReadModel());
  const activeProjects = readModel.projects.filter((project) => project.deletedAt === null);
  const existing = activeProjects.find(
    (project) =>
      project.id === desired.id ||
      path.resolve(project.workspaceRoot) === path.resolve(desired.workspaceRoot),
  );
  const now = new Date().toISOString();
  if (!existing) {
    await engine
      .dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe(`penkra:project:create:${desired.id}`),
        projectId: ProjectId.makeUnsafe(desired.id),
        title: desired.title,
        workspaceRoot: desired.workspaceRoot,
        createWorkspaceRootIfMissing: true,
        isPinned: desired.isPinned,
        createdAt: now,
      })
      .pipe(Effect.runPromise);
    return;
  }
  if (projectMatches(existing, desired)) return;
  const revision = stableRevision(desired);
  await engine
    .dispatch({
      type: "project.meta.update",
      commandId: CommandId.makeUnsafe(`penkra:project:update:${existing.id}:${revision}`),
      projectId: existing.id,
      title: desired.title,
      workspaceRoot: desired.workspaceRoot,
      createWorkspaceRootIfMissing: true,
      ...(desired.enforcePin ? { isPinned: desired.isPinned } : {}),
    })
    .pipe(Effect.runPromise);
}

function projectMatches(
  project: OrchestrationProject,
  desired: { title: string; workspaceRoot: string; isPinned: boolean; enforcePin: boolean },
): boolean {
  return (
    project.title === desired.title &&
    path.resolve(project.workspaceRoot) === path.resolve(desired.workspaceRoot) &&
    (!desired.enforcePin || project.isPinned === desired.isPinned)
  );
}

function stableRevision(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url").slice(0, 80);
}

async function findUnknownFolders(root: string, clients: PenkraClientRecord[]): Promise<string[]> {
  const known = new Set(clients.map((client) => client.id));
  const entries = await readdir(root, { withFileTypes: true });
  const unknown: string[] = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      known.has(entry.name) ||
      entry.name === "hq" ||
      entry.name.startsWith(".")
    )
      continue;
    try {
      const text = await readFile(path.join(root, entry.name, ".penkra", "config.json"), "utf8");
      const config = JSON.parse(text) as Record<string, unknown>;
      if (config.scope === "client") unknown.push(entry.name);
    } catch {
      // Ordinary non-Penkra folders are not registry orphans.
    }
  }
  return unknown.sort();
}

function emptyResult(status: "disabled" | "needs-hq-auth"): RegistrySyncResult {
  return { status, clients: 0, unknownFolders: [], archivedClients: [] };
}
