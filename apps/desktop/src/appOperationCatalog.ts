// FILE: appOperationCatalog.ts
// Purpose: Indexes enabled App operations and canonical package-authored help.
// Layer: Trusted desktop App discovery boundary

import * as FS from "node:fs";
import * as Path from "node:path";

import { generateAppHelp, PENKRA_APP_INSTRUCTIONS_MAX_BYTES } from "@penkra/sdk";

import type { AppInstallationState, InstalledAppPackage } from "./appInstallationState";

export interface AppOperationCatalogEntry {
  appId: string;
  slug: string;
  name: string;
  summary: string;
  version: string;
  operations: ReadonlyArray<{ key: string; summary: string }>;
}

export class AppOperationCatalog {
  readonly #installationState: () => AppInstallationState;

  constructor(installationState: () => AppInstallationState) {
    this.#installationState = installationState;
  }

  list(spaceId: string): AppOperationCatalogEntry[] {
    const state = this.#installationState();
    return Object.values(state.packagesByAppId)
      .filter((app) => isEnabled(state, app.appId, spaceId))
      .map((app) => ({
        appId: app.appId,
        slug: app.slug,
        name: app.name,
        summary: app.summary,
        version: app.version,
        operations: (app.manifest.operations ?? []).map(({ key, summary }) => ({ key, summary })),
      }))
      .sort((left, right) => left.slug.localeCompare(right.slug));
  }

  async help(input: { spaceId: string; slug: string; operation?: string }): Promise<string> {
    const state = this.#installationState();
    const app = Object.values(state.packagesByAppId).find((candidate) => candidate.slug === input.slug);
    if (!app || !isEnabled(state, app.appId, input.spaceId)) {
      throw new Error(`App ${input.slug} is not enabled in Space ${input.spaceId}.`);
    }
    return generateAppHelp({
      manifest: app.manifest,
      instructions: await readInstructions(app),
      ...(input.operation === undefined ? {} : { operation: input.operation }),
    });
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
  if (Path.dirname(instructionsPath) !== packagePath) throw new Error("App instructions path escaped its package.");
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
