// FILE: appOperationCatalog.ts
// Purpose: Indexes enabled App operations and canonical package-authored help.
// Layer: Trusted desktop App discovery boundary

import * as FS from "node:fs";
import * as Path from "node:path";

import { generateAppHelp, PENKRA_APP_INSTRUCTIONS_MAX_BYTES } from "@penkra/sdk";

import {
  findInstalledAppBySlug,
  listInstalledAppsForSpace,
  type AppInstallationState,
  type InstalledAppPackage,
} from "./appInstallationState";

export interface AppOperationCatalogEntry {
  appId: string;
  slug: string;
  name: string;
  summary: string;
  version: string;
  operations: ReadonlyArray<{
    key: string;
    summary: string;
    input: Readonly<Record<string, unknown>>;
  }>;
}

export interface AppSkillCatalogEntry {
  appId: string;
  slug: string;
  name: string;
  path: string;
  skillPath: string;
  enabled: boolean;
  scope: string;
}

export class AppOperationCatalog {
  readonly #installationState: () => AppInstallationState;

  constructor(installationState: () => AppInstallationState) {
    this.#installationState = installationState;
  }

  list(spaceId: string): AppOperationCatalogEntry[] {
    const state = this.#installationState();
    return listInstalledAppsForSpace(state, spaceId)
      .filter((app) => isEnabled(state, app.appId, spaceId))
      .map((app) => ({
        appId: app.appId,
        slug: app.slug,
        name: app.name,
        summary: app.summary,
        version: app.version,
        operations: (app.manifest.operations ?? []).map(({ key, summary, input }) => ({
          key,
          summary,
          input,
        })),
      }))
      .sort((left, right) => left.slug.localeCompare(right.slug));
  }

  async help(input: { spaceId: string; slug: string; operation?: string }): Promise<string> {
    const state = this.#installationState();
    const app = findInstalledAppBySlug(state, input.slug, input.spaceId);
    if (!app || !isEnabled(state, app.appId, input.spaceId)) {
      throw new Error(`App ${input.slug} is not enabled in Space ${input.spaceId}.`);
    }
    return generateAppHelp({
      manifest: app.manifest,
      instructions: await readInstructions(app),
      ...(input.operation === undefined ? {} : { operation: input.operation }),
    });
  }

  async skills(spaceId: string): Promise<AppSkillCatalogEntry[]> {
    const state = this.#installationState();
    const result: AppSkillCatalogEntry[] = [];
    for (const app of listInstalledAppsForSpace(state, spaceId)) {
      const space = Object.values(state.spaceStateByKey).find(
        (candidate) => candidate.appId === app.appId && candidate.spaceId === spaceId,
      );
      if (!space?.enabled) continue;
      for (const declaration of app.manifest.contributions?.skills ?? []) {
        const skillPath = await resolveSkillPath(app, declaration.path);
        result.push({
          appId: app.appId,
          slug: app.slug,
          name: app.name,
          path: declaration.path,
          skillPath,
          enabled: space.skills[declaration.path] ?? true,
          scope: `app:${app.slug}`,
        });
      }
    }
    return result.sort(
      (left, right) => left.slug.localeCompare(right.slug) || left.path.localeCompare(right.path),
    );
  }
}

function isEnabled(state: AppInstallationState, appId: string, spaceId: string): boolean {
  return Object.values(state.spaceStateByKey).some(
    (space) => space.appId === appId && space.spaceId === spaceId && space.enabled,
  );
}

async function readInstructions(app: InstalledAppPackage): Promise<string> {
  const packagePath = Path.resolve(app.packagePath);
  const instructionsPath = Path.resolve(packagePath, "INSTRUCTIONS.md");
  if (Path.dirname(instructionsPath) !== packagePath)
    throw new Error("App instructions path escaped its package.");
  const stats = await FS.promises.lstat(instructionsPath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > PENKRA_APP_INSTRUCTIONS_MAX_BYTES) {
    throw new Error(`App ${app.slug} instructions are not a valid bounded file.`);
  }
  const bytes = await FS.promises.readFile(instructionsPath);
  let instructions: string;
  try {
    instructions = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`App ${app.slug} instructions are not valid UTF-8.`, { cause: error });
  }
  if (!instructions.trim()) throw new Error(`App ${app.slug} instructions are empty.`);
  return instructions;
}

async function resolveSkillPath(app: InstalledAppPackage, relativePath: string): Promise<string> {
  const packagePath = Path.resolve(app.packagePath);
  const directory = Path.resolve(packagePath, relativePath);
  const skillPath = Path.resolve(directory, "SKILL.md");
  if (!directory.startsWith(`${packagePath}${Path.sep}`) || Path.dirname(skillPath) !== directory) {
    throw new Error(`App ${app.slug} skill path escaped its immutable package.`);
  }
  const [directoryStats, skillStats] = await Promise.all([
    FS.promises.lstat(directory),
    FS.promises.lstat(skillPath),
  ]);
  if (
    !directoryStats.isDirectory() ||
    directoryStats.isSymbolicLink() ||
    !skillStats.isFile() ||
    skillStats.isSymbolicLink()
  ) {
    throw new Error(`App ${app.slug} skill is not a regular package file.`);
  }
  return skillPath;
}
