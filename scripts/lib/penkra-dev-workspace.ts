// FILE: penkra-dev-workspace.ts
// Purpose: Persist and discover the local repository paths used by Penkra Dev.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const BACKEND_ORIGIN = "github.com/penkrahq/penkra-backend";

export interface PenkraDevWorkspace {
  readonly desktopRoot: string;
  readonly backendRoot: string;
}

export function resolvePenkraDevWorkspaceConfigPath(homeDirectory = homedir()): string {
  return join(homeDirectory, "Penkra_Dev", ".launcher", "workspace.json");
}

export function validatePenkraDevWorkspace(input: PenkraDevWorkspace): PenkraDevWorkspace {
  const workspace = {
    desktopRoot: resolve(input.desktopRoot),
    backendRoot: resolve(input.backendRoot),
  };
  const requiredPaths = [
    join(workspace.desktopRoot, "scripts", "penkra-dev-launcher.ts"),
    join(workspace.backendRoot, "ops", "dev-workspace.mjs"),
  ];
  const missingPath = requiredPaths.find((path) => !existsSync(path));
  if (missingPath) {
    throw new Error(`Penkra Dev workspace is missing a required path: ${missingPath}`);
  }
  return workspace;
}

export function readPenkraDevWorkspace(
  configPath = resolvePenkraDevWorkspaceConfigPath(),
): PenkraDevWorkspace {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Penkra Dev workspace configuration is unavailable at ${configPath}. Reinstall the Penkra Dev launcher.`,
      { cause: error },
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("desktopRoot" in parsed) ||
    typeof parsed.desktopRoot !== "string" ||
    !("backendRoot" in parsed) ||
    typeof parsed.backendRoot !== "string"
  ) {
    throw new Error(`Penkra Dev workspace configuration is invalid at ${configPath}.`);
  }
  return validatePenkraDevWorkspace(parsed as PenkraDevWorkspace);
}

export function writePenkraDevWorkspace(
  workspace: PenkraDevWorkspace,
  configPath = resolvePenkraDevWorkspaceConfigPath(),
): PenkraDevWorkspace {
  const validated = validatePenkraDevWorkspace(workspace);
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${configPath}.${String(process.pid)}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporaryPath, configPath);
  return validated;
}

function normalizeGitRemote(remote: string): string {
  return remote
    .trim()
    .replace(/^git@github\.com:/u, "github.com/")
    .replace(/^https?:\/\/github\.com\//u, "github.com/")
    .replace(/\.git$/u, "");
}

function repositoryMatchesOrigin(repositoryRoot: string, expectedOrigin: string): boolean {
  const result = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return result.status === 0 && normalizeGitRemote(result.stdout) === expectedOrigin;
}

export function discoverPenkraBackendRoot(input: {
  readonly desktopRoot: string;
  readonly configuredBackendRoot?: string;
  readonly workspaceParent?: string;
}): string {
  const configured = input.configuredBackendRoot?.trim();
  if (configured) {
    return validatePenkraDevWorkspace({
      desktopRoot: input.desktopRoot,
      backendRoot: configured,
    }).backendRoot;
  }

  const workspaceParent = resolve(input.workspaceParent ?? dirname(input.desktopRoot));
  for (const entry of readdirSync(workspaceParent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(workspaceParent, entry.name);
    if (repositoryMatchesOrigin(candidate, BACKEND_ORIGIN)) {
      return validatePenkraDevWorkspace({
        desktopRoot: input.desktopRoot,
        backendRoot: candidate,
      }).backendRoot;
    }
  }
  throw new Error(
    "Cannot locate the Penkra backend repository. Set PENKRA_BACKEND_ROOT or place its checkout in the same workspace before reinstalling Penkra Dev.",
  );
}
