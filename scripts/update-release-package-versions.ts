import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parseTree,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";

export const releasePackageFiles = [
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
] as const;

interface UpdateReleasePackageVersionsOptions {
  readonly rootDir?: string;
}

interface MutablePackageJson {
  version?: string;
  [key: string]: unknown;
}

interface PackageVersionUpdate {
  readonly filePath: string;
  readonly manifest: MutablePackageJson;
  readonly workspacePath: string;
}

const releaseLockfilePath = "bun.lock";

function parseLockfileTree(lockfile: string, lockfilePath: string) {
  const errors: ParseError[] = [];
  const tree = parseTree(lockfile, errors, { allowTrailingComma: true });
  if (!tree || errors.length > 0) {
    const detail = errors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(", ");
    throw new Error(`Invalid release lockfile ${lockfilePath}: ${detail || "missing JSONC root"}.`);
  }
  return tree;
}

function updateReleaseLockfileVersions(
  lockfilePath: string,
  version: string,
  updates: ReadonlyArray<PackageVersionUpdate>,
): boolean {
  let lockfile: string;
  try {
    lockfile = readFileSync(lockfilePath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read release lockfile ${lockfilePath}.`, { cause: error });
  }

  const tree = parseLockfileTree(lockfile, lockfilePath);
  for (const update of updates) {
    const importer = findNodeAtLocation(tree, ["workspaces", update.workspacePath]);
    if (!importer || importer.type !== "object") {
      throw new Error(
        `Release lockfile ${lockfilePath} is missing workspace importer ${update.workspacePath}.`,
      );
    }
    const importerVersion = findNodeAtLocation(tree, [
      "workspaces",
      update.workspacePath,
      "version",
    ]);
    if (!importerVersion || importerVersion.type !== "string") {
      throw new Error(
        `Release lockfile importer ${update.workspacePath} is missing a valid string version field.`,
      );
    }
  }

  const edits = updates.flatMap((update) =>
    modify(lockfile, ["workspaces", update.workspacePath, "version"], version, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }),
  );
  const updatedLockfile = applyEdits(lockfile, edits);
  const updatedTree = parseLockfileTree(updatedLockfile, lockfilePath);
  for (const update of updates) {
    const importerVersion = findNodeAtLocation(updatedTree, [
      "workspaces",
      update.workspacePath,
      "version",
    ]);
    if (importerVersion?.value !== version) {
      throw new Error(
        `Failed to update release lockfile importer ${update.workspacePath} to ${version}.`,
      );
    }
  }

  if (updatedLockfile === lockfile) return false;
  writeFileSync(lockfilePath, updatedLockfile);
  return true;
}

export function updateReleasePackageVersions(
  version: string,
  options: UpdateReleasePackageVersionsOptions = {},
): { changed: boolean } {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const updates = releasePackageFiles.map((relativePath): PackageVersionUpdate => {
    const filePath = resolve(rootDir, relativePath);
    const packageJson = JSON.parse(readFileSync(filePath, "utf8")) as MutablePackageJson;
    return {
      filePath,
      manifest: packageJson,
      workspacePath: dirname(relativePath),
    };
  });

  const lockfileChanged = updateReleaseLockfileVersions(
    resolve(rootDir, releaseLockfilePath),
    version,
    updates,
  );
  let manifestChanged = false;

  for (const update of updates) {
    if (update.manifest.version === version) continue;
    update.manifest.version = version;
    writeFileSync(update.filePath, `${JSON.stringify(update.manifest, null, 2)}\n`);
    manifestChanged = true;
  }

  return { changed: manifestChanged || lockfileChanged };
}

function parseArgs(argv: ReadonlyArray<string>): {
  version: string;
  rootDir: string | undefined;
  writeGithubOutput: boolean;
} {
  let version: string | undefined;
  let rootDir: string | undefined;
  let writeGithubOutput = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }

    if (argument === "--github-output") {
      writeGithubOutput = true;
      continue;
    }

    if (argument === "--root") {
      rootDir = argv[index + 1];
      if (!rootDir) {
        throw new Error("Missing value for --root.");
      }
      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      throw new Error(`Unknown argument: ${argument}`);
    }

    if (version !== undefined) {
      throw new Error("Only one release version can be provided.");
    }
    version = argument;
  }

  if (!version) {
    throw new Error(
      "Usage: node scripts/update-release-package-versions.ts <version> [--root <path>] [--github-output]",
    );
  }

  return { version, rootDir, writeGithubOutput };
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { version, rootDir, writeGithubOutput } = parseArgs(process.argv.slice(2));
  const { changed } = updateReleasePackageVersions(
    version,
    rootDir === undefined ? {} : { rootDir },
  );

  if (!changed) {
    console.log("All package.json versions already match release version.");
  }

  if (writeGithubOutput) {
    const githubOutputPath = process.env.GITHUB_OUTPUT;
    if (!githubOutputPath) {
      throw new Error("GITHUB_OUTPUT is required when --github-output is set.");
    }
    appendFileSync(githubOutputPath, `changed=${changed}\n`);
  }
}
