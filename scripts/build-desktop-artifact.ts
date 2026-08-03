#!/usr/bin/env node
// FILE: build-desktop-artifact.ts
// Purpose: Stages and builds packaged desktop artifacts plus Penkra updater metadata.
// Layer: Release/build script
// Depends on: apps/desktop package metadata and electron-builder.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import rootPackageJson from "../package.json" with { type: "json" };
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { createDesktopPlatformBuildConfig } from "./lib/desktop-platform-build-config.ts";
import {
  PENKRA_ACCOUNT_AUTH_SCHEME,
  PENKRA_DESKTOP_SCHEME,
  PENKRA_PRODUCTION_BUNDLE_ID,
} from "@penkra/shared/desktopIdentity";
import { parseBooleanEnvValue } from "./lib/env-bool.ts";
import { finalizeSignedMacDmg } from "./lib/mac-dmg-finalize.ts";
import { finalizeMacUpdateZip } from "./lib/mac-update-zip-finalize.ts";
import { resolveUnusedClaudePlatformPackageName } from "./lib/desktop-staged-runtime.ts";
import {
  RELEASE_LOCKFILE_PATH,
  RELEASE_PATCHES_PATH,
  RELEASE_WORKSPACE_MANIFEST_PATHS,
} from "./lib/release-workspace-manifests.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Data, Effect, FileSystem, Layer, Logger, Option, Path, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const BuildPlatform = Schema.Literals(["mac"]);
const BuildArch = Schema.Literals(["arm64", "x64", "universal"]);
const PENKRA_APPS_PACKAGE_PATH_ENV = "PENKRA_APPS_PACKAGE_PATH";
const requireFromScriptsWorkspace = createRequire(new URL("./package.json", import.meta.url));

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);
const ProductionMacIconSource = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, BRAND_ASSET_PATHS.productionMacIconPng),
);
const ProductionMacLegacyIconSource = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, BRAND_ASSET_PATHS.productionMacLegacyIconPng),
);
const encodeJsonString = Schema.encodeEffect(Schema.UnknownFromJsonString);

interface PlatformConfig {
  readonly cliFlag: "--mac";
  readonly defaultTarget: string;
  readonly archChoices: ReadonlyArray<typeof BuildArch.Type>;
}

const PLATFORM_CONFIG: Record<typeof BuildPlatform.Type, PlatformConfig> = {
  mac: {
    cliFlag: "--mac",
    defaultTarget: "dmg",
    archChoices: ["arm64", "x64", "universal"],
  },
};

interface BuildCliInput {
  readonly platform: Option.Option<typeof BuildPlatform.Type>;
  readonly target: Option.Option<string>;
  readonly arch: Option.Option<typeof BuildArch.Type>;
  readonly buildVersion: Option.Option<string>;
  readonly sourceCommit: Option.Option<string>;
  readonly sourceTag: Option.Option<string>;
  readonly lockfileSha256: Option.Option<string>;
  readonly outputDir: Option.Option<string>;
  readonly skipBuild: Option.Option<boolean>;
  readonly keepStage: Option.Option<boolean>;
  readonly signed: Option.Option<boolean>;
  readonly localSign: Option.Option<boolean>;
  readonly verbose: Option.Option<boolean>;
  readonly mockUpdates: Option.Option<boolean>;
  readonly mockUpdateServerPort: Option.Option<string>;
}

function detectHostBuildPlatform(hostPlatform: string): typeof BuildPlatform.Type | undefined {
  if (hostPlatform === "darwin") return "mac";
  return undefined;
}

function getDefaultArch(platform: typeof BuildPlatform.Type): typeof BuildArch.Type {
  const config = PLATFORM_CONFIG[platform];
  if (!config) {
    return "x64";
  }

  if (process.arch === "arm64" && config.archChoices.includes("arm64")) {
    return "arm64";
  }
  if (process.arch === "x64" && config.archChoices.includes("x64")) {
    return "x64";
  }

  return config.archChoices[0] ?? "x64";
}

class BuildScriptError extends Data.TaggedError("BuildScriptError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function resolveGitCommitHash(repoRoot: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return undefined;
  }
  const hash = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(hash)) {
    return undefined;
  }
  return hash.toLowerCase();
}

function resolveLockfileSha256(repoRoot: string): string {
  return createHash("sha256")
    .update(readFileSync(join(repoRoot, "bun.lock")))
    .digest("hex");
}

interface ResolvedBuildOptions {
  readonly platform: typeof BuildPlatform.Type;
  readonly target: string;
  readonly arch: typeof BuildArch.Type;
  readonly version: string | undefined;
  readonly sourceCommit: string | undefined;
  readonly sourceTag: string | undefined;
  readonly lockfileSha256: string | undefined;
  readonly outputDir: string;
  readonly skipBuild: boolean;
  readonly keepStage: boolean;
  readonly signed: boolean;
  readonly localSign: boolean;
  readonly verbose: boolean;
  readonly mockUpdates: boolean;
  readonly mockUpdateServerPort: string | undefined;
}

interface StagePackageJson {
  readonly name: string;
  readonly version: string;
  readonly buildVersion: string;
  readonly penkraCommitHash: string;
  readonly penkraLockfileSha256: string;
  readonly penkraSourceTag: string | null;
  readonly private: true;
  readonly description: string;
  readonly author: string;
  readonly main: string;
  readonly build: Record<string, unknown>;
  readonly dependencies: Record<string, unknown>;
  readonly devDependencies: {
    readonly electron: string;
  };
  readonly overrides: Record<string, unknown>;
}

const BuildEnvConfig = Config.all({
  platform: Config.schema(BuildPlatform, "PENKRA_DESKTOP_PLATFORM").pipe(Config.option),
  target: Config.string("PENKRA_DESKTOP_TARGET").pipe(Config.option),
  arch: Config.schema(BuildArch, "PENKRA_DESKTOP_ARCH").pipe(Config.option),
  version: Config.string("PENKRA_DESKTOP_VERSION").pipe(Config.option),
  sourceCommit: Config.string("PENKRA_SOURCE_COMMIT").pipe(Config.option),
  sourceTag: Config.string("PENKRA_SOURCE_TAG").pipe(Config.option),
  lockfileSha256: Config.string("PENKRA_LOCKFILE_SHA256").pipe(Config.option),
  outputDir: Config.string("PENKRA_DESKTOP_OUTPUT_DIR").pipe(Config.option),
  skipBuild: Config.string("PENKRA_DESKTOP_SKIP_BUILD").pipe(Config.option),
  keepStage: Config.string("PENKRA_DESKTOP_KEEP_STAGE").pipe(Config.option),
  signed: Config.string("PENKRA_DESKTOP_SIGNED").pipe(Config.option),
  localSign: Config.string("PENKRA_DESKTOP_LOCAL_SIGN").pipe(Config.option),
  verbose: Config.string("PENKRA_DESKTOP_VERBOSE").pipe(Config.option),
  mockUpdates: Config.string("PENKRA_DESKTOP_MOCK_UPDATES").pipe(Config.option),
  mockUpdateServerPort: Config.string("PENKRA_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(Config.option),
});

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(flag, () => envValue);
const mergeOptions = <A>(a: Option.Option<A>, b: Option.Option<A>, defaultValue: A) =>
  Option.getOrElse(a, () => Option.getOrElse(b, () => defaultValue));
const resolveBooleanEnv = (name: string, value: Option.Option<string>) =>
  Effect.try({
    try: () =>
      Option.match(value, {
        onNone: () => false,
        onSome: (rawValue) => parseBooleanEnvValue(name, rawValue),
      }),
    catch: (cause) =>
      new BuildScriptError({
        message: cause instanceof Error ? cause.message : `Could not parse ${name}.`,
        cause,
      }),
  });

export const resolveBuildOptions = Effect.fn("resolveBuildOptions")(function* (
  input: BuildCliInput,
) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const env = yield* BuildEnvConfig.asEffect();

  const platform = mergeOptions(
    input.platform,
    env.platform,
    detectHostBuildPlatform(process.platform),
  );

  if (!platform) {
    return yield* new BuildScriptError({
      message: `Unsupported host platform '${process.platform}'.`,
    });
  }

  const target = mergeOptions(input.target, env.target, PLATFORM_CONFIG[platform].defaultTarget);
  const arch = mergeOptions(input.arch, env.arch, getDefaultArch(platform));
  const version = mergeOptions(input.buildVersion, env.version, undefined);
  const sourceCommit = mergeOptions(input.sourceCommit, env.sourceCommit, undefined);
  const sourceTag = mergeOptions(input.sourceTag, env.sourceTag, undefined);
  const lockfileSha256 = mergeOptions(input.lockfileSha256, env.lockfileSha256, undefined);
  const envSkipBuild = yield* resolveBooleanEnv("PENKRA_DESKTOP_SKIP_BUILD", env.skipBuild);
  const envKeepStage = yield* resolveBooleanEnv("PENKRA_DESKTOP_KEEP_STAGE", env.keepStage);
  const envSigned = yield* resolveBooleanEnv("PENKRA_DESKTOP_SIGNED", env.signed);
  const envLocalSign = yield* resolveBooleanEnv("PENKRA_DESKTOP_LOCAL_SIGN", env.localSign);
  const envVerbose = yield* resolveBooleanEnv("PENKRA_DESKTOP_VERBOSE", env.verbose);
  const envMockUpdates = yield* resolveBooleanEnv("PENKRA_DESKTOP_MOCK_UPDATES", env.mockUpdates);
  const releaseDir = resolveBooleanFlag(input.mockUpdates, envMockUpdates)
    ? "release-mock"
    : "release";
  const outputDir = path.resolve(
    repoRoot,
    mergeOptions(input.outputDir, env.outputDir, releaseDir),
  );

  const skipBuild = resolveBooleanFlag(input.skipBuild, envSkipBuild);
  const keepStage = resolveBooleanFlag(input.keepStage, envKeepStage);
  const signed = resolveBooleanFlag(input.signed, envSigned);
  const localSign = resolveBooleanFlag(input.localSign, envLocalSign);
  if (signed && localSign) {
    return yield* new BuildScriptError({
      message: "Use either --signed or --local-sign, not both.",
    });
  }
  const verbose = resolveBooleanFlag(input.verbose, envVerbose);
  const mockUpdates = resolveBooleanFlag(input.mockUpdates, envMockUpdates);
  const mockUpdateServerPort = mergeOptions(
    input.mockUpdateServerPort,
    env.mockUpdateServerPort,
    undefined,
  );

  return {
    platform,
    target,
    arch,
    version,
    sourceCommit,
    sourceTag,
    lockfileSha256,
    outputDir,
    skipBuild,
    keepStage,
    signed,
    localSign,
    verbose,
    mockUpdates,
    mockUpdateServerPort,
  } satisfies ResolvedBuildOptions;
});

const commandOutputOptions = (verbose: boolean) =>
  ({
    stdout: verbose ? "inherit" : "ignore",
    stderr: "inherit",
  }) as const;

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.Command) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* commandSpawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new BuildScriptError({
      message: `Command exited with non-zero exit code (${exitCode})`,
    });
  }
});

function generateMacIconSet(
  sourcePng: string,
  targetIcns: string,
  tmpRoot: string,
  path: Path.Path,
  verbose: boolean,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const iconsetDir = path.join(tmpRoot, "icon.iconset");
    yield* fs.makeDirectory(iconsetDir, { recursive: true });

    const iconSizes = [16, 32, 128, 256, 512] as const;
    for (const size of iconSizes) {
      yield* runCommand(
        ChildProcess.make({
          ...commandOutputOptions(verbose),
        })`sips -z ${size} ${size} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}.png`)}`,
      );

      const retinaSize = size * 2;
      yield* runCommand(
        ChildProcess.make({
          ...commandOutputOptions(verbose),
        })`sips -z ${retinaSize} ${retinaSize} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}@2x.png`)}`,
      );
    }

    yield* runCommand(
      ChildProcess.make({
        ...commandOutputOptions(verbose),
      })`iconutil -c icns ${iconsetDir} -o ${targetIcns}`,
    );
  });
}

function stageMacIcons(stageResourcesDir: string, verbose: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const modernIconSource = yield* ProductionMacIconSource;
    if (!(yield* fs.exists(modernIconSource))) {
      return yield* new BuildScriptError({
        message: `Production macOS icon source is missing at ${modernIconSource}`,
      });
    }
    const legacyIconSource = yield* ProductionMacLegacyIconSource;
    if (!(yield* fs.exists(legacyIconSource))) {
      return yield* new BuildScriptError({
        message: `Production legacy macOS icon source is missing at ${legacyIconSource}`,
      });
    }

    const tmpRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "penkra-icon-build-",
    });

    const iconPngPath = path.join(stageResourcesDir, "icon.png");
    const iconIcnsPath = path.join(stageResourcesDir, "icon.icns");
    const dockIconPngPath = path.join(stageResourcesDir, "dock-icon.png");

    yield* runCommand(
      ChildProcess.make({
        ...commandOutputOptions(verbose),
      })`sips -z 512 512 ${modernIconSource} --out ${iconPngPath}`,
    );

    // The solid ICNS is the bundle icon on every macOS release; Icon Composer glass alters the mark.
    yield* runCommand(
      ChildProcess.make({
        ...commandOutputOptions(verbose),
      })`sips -z 1024 1024 ${legacyIconSource} --out ${dockIconPngPath}`,
    );

    yield* generateMacIconSet(legacyIconSource, iconIcnsPath, tmpRoot, path, verbose);
  });
}

function validateBundledClientAssets(clientDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const indexPath = path.join(clientDir, "index.html");
    const indexHtml = yield* fs.readFileString(indexPath);
    const refs = [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    const missing: string[] = [];

    for (const ref of refs) {
      const normalizedRef = ref.split("#")[0]?.split("?")[0] ?? "";
      if (!normalizedRef) continue;
      if (normalizedRef.startsWith("http://") || normalizedRef.startsWith("https://")) continue;
      if (normalizedRef.startsWith("data:") || normalizedRef.startsWith("mailto:")) continue;

      const ext = path.extname(normalizedRef);
      if (!ext) continue;

      const relativePath = normalizedRef.replace(/^\/+/, "");
      const assetPath = path.join(clientDir, relativePath);
      if (!(yield* fs.exists(assetPath))) {
        missing.push(normalizedRef);
      }
    }

    if (missing.length > 0) {
      const preview = missing.slice(0, 6).join(", ");
      const suffix = missing.length > 6 ? ` (+${missing.length - 6} more)` : "";
      return yield* new BuildScriptError({
        message: `Bundled client references missing files in ${indexPath}: ${preview}${suffix}. Rebuild web/server artifacts.`,
      });
    }
  });
}

function resolveDesktopRuntimeDependencies(
  dependencies: Record<string, unknown> | undefined,
  catalog: Record<string, unknown>,
): Record<string, unknown> {
  if (!dependencies || Object.keys(dependencies).length === 0) {
    return {};
  }

  const runtimeDependencies = Object.fromEntries(
    Object.entries(dependencies).filter(
      ([dependencyName, version]) =>
        dependencyName !== "electron" &&
        !(typeof version === "string" && version.startsWith("workspace:")),
    ),
  );

  return resolveCatalogDependencies(runtimeDependencies, catalog, "apps/desktop");
}

function resolveMockUpdateUrl(
  mockUpdates: boolean,
  mockUpdateServerPort: string | undefined,
): string {
  if (mockUpdates) return `http://localhost:${mockUpdateServerPort ?? 3000}`;
  throw new Error("A mock update URL is only valid for a mock update build.");
}

interface PatchFileExpectation {
  readonly file: string;
  readonly addedLines: ReadonlyArray<string>;
}

function parsePatchAddedLines(patchContents: string): PatchFileExpectation[] {
  const expectations: Array<{ file: string; addedLines: string[] }> = [];
  let current: { file: string; addedLines: string[] } | null = null;
  for (const line of patchContents.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") {
        current = null;
        continue;
      }
      current = { file: target.startsWith("b/") ? target.slice(2) : target, addedLines: [] };
      expectations.push(current);
      continue;
    }
    if (current && line.startsWith("+")) {
      const added = line.slice(1).trim();
      if (added.length > 0) {
        current.addedLines.push(added);
      }
    }
  }
  return expectations.filter((expectation) => expectation.addedLines.length > 0);
}

// Package managers can silently skip tracked patches when the staged install
// diverges from the repo setup, so fail the build unless every patched line is present.
const verifyStagedPatchedDependencies = Effect.fn("verifyStagedPatchedDependencies")(function* (
  repoRoot: string,
  stageAppDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.log("[desktop-artifact] Verifying staged patched dependencies...");
  for (const [dependency, patchRelativePath] of Object.entries(
    rootPackageJson.patchedDependencies ?? {},
  )) {
    const packageName = dependency.slice(0, dependency.indexOf("@", 1));
    const patchContents = yield* fs.readFileString(path.join(repoRoot, patchRelativePath));
    for (const expectation of parsePatchAddedLines(patchContents)) {
      const stagedFilePath = path.join(stageAppDir, "node_modules", packageName, expectation.file);
      const stagedContents = yield* fs.readFileString(stagedFilePath).pipe(
        Effect.mapError(
          (cause) =>
            new BuildScriptError({
              message: `Patched dependency file is missing from the stage: ${stagedFilePath} (expected by ${patchRelativePath}).`,
              cause,
            }),
        ),
      );
      for (const addedLine of expectation.addedLines) {
        if (!stagedContents.includes(addedLine)) {
          return yield* new BuildScriptError({
            message: `Staged dependency ${packageName} is missing patched content: ${expectation.file} does not contain "${addedLine}" from ${patchRelativePath}. The tracked patch was not applied by the staged install.`,
          });
        }
      }
    }
  }
});

const installFrozenStageDependencies = Effect.fn("installFrozenStageDependencies")(function* (
  repoRoot: string,
  stageAppDir: string,
  verbose: boolean,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const relativePath of RELEASE_WORKSPACE_MANIFEST_PATHS) {
    const destination = path.join(stageAppDir, relativePath);
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
    yield* fs.copyFile(path.join(repoRoot, relativePath), destination);
  }
  yield* fs.copyFile(
    path.join(repoRoot, RELEASE_LOCKFILE_PATH),
    path.join(stageAppDir, RELEASE_LOCKFILE_PATH),
  );
  yield* fs.copy(
    path.join(repoRoot, RELEASE_PATCHES_PATH),
    path.join(stageAppDir, RELEASE_PATCHES_PATH),
  );

  yield* Effect.log(
    "[desktop-artifact] Installing staged production dependencies from the repository lockfile...",
  );
  yield* runCommand(
    ChildProcess.make({
      cwd: stageAppDir,
      ...commandOutputOptions(verbose),
    })`bun install --frozen-lockfile --ignore-scripts --linker hoisted`,
  );

  yield* verifyStagedPatchedDependencies(repoRoot, stageAppDir);

  for (const relativePath of RELEASE_WORKSPACE_MANIFEST_PATHS) {
    if (relativePath !== "package.json") {
      yield* fs.remove(path.join(stageAppDir, relativePath));
    }
  }
  yield* fs.remove(path.join(stageAppDir, RELEASE_LOCKFILE_PATH));
  yield* fs.remove(path.join(stageAppDir, RELEASE_PATCHES_PATH), { recursive: true });
});

const createBuildConfig = Effect.fn("createBuildConfig")(function* (
  platform: typeof BuildPlatform.Type,
  target: string,
  productName: string,
  signed: boolean,
  notarize: boolean,
  mockUpdates: boolean,
  mockUpdateServerPort: string | undefined,
) {
  const buildConfig: Record<string, unknown> = {
    appId: PENKRA_PRODUCTION_BUNDLE_ID,
    productName,
    artifactName: "Penkra-${version}-${arch}.${ext}",
    protocols: [
      {
        name: "Penkra App Listings",
        schemes: [PENKRA_DESKTOP_SCHEME],
      },
      {
        name: "Penkra Account Authentication",
        schemes: [PENKRA_ACCOUNT_AUTH_SCHEME],
      },
    ],
    directories: {
      buildResources: "apps/desktop/resources",
    },
    extraResources: [{ from: "penkra-apps", to: "penkra-apps" }],
    forceCodeSigning: signed,
  };
  buildConfig.publish = mockUpdates
    ? [
        {
          provider: "generic",
          url: resolveMockUpdateUrl(mockUpdates, mockUpdateServerPort),
          useMultipleRangeRequest: false,
        },
      ]
    : [
        {
          provider: "github",
          owner: "penkrahq",
          repo: "penkra",
        },
      ];

  const platformBuildConfigInput = {
    platform,
    target,
    signed,
    notarize,
  } as const;

  Object.assign(buildConfig, createDesktopPlatformBuildConfig(platformBuildConfigInput));

  return buildConfig;
});

const assertPlatformBuildResources = Effect.fn("assertPlatformBuildResources")(function* (
  platform: typeof BuildPlatform.Type,
  stageResourcesDir: string,
  verbose: boolean,
) {
  yield* stageMacIcons(stageResourcesDir, verbose);
});

const buildDesktopArtifact = Effect.fn("buildDesktopArtifact")(function* (
  options: ResolvedBuildOptions,
) {
  const repoRoot = yield* RepoRoot;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  const platformConfig = PLATFORM_CONFIG[options.platform];
  if (!platformConfig) {
    return yield* new BuildScriptError({
      message: `Unsupported platform '${options.platform}'.`,
    });
  }
  const electronVersion = desktopPackageJson.dependencies.electron;

  const serverDependencies = serverPackageJson.dependencies;
  if (!serverDependencies || Object.keys(serverDependencies).length === 0) {
    return yield* new BuildScriptError({
      message: "Could not resolve production dependencies from apps/server/package.json.",
    });
  }

  const resolvedOverrides = yield* Effect.try({
    try: () =>
      resolveCatalogDependencies(
        rootPackageJson.overrides,
        rootPackageJson.workspaces.catalog,
        "apps/desktop",
      ),
    catch: (cause) =>
      new BuildScriptError({
        message: "Could not resolve overrides from package.json.",
        cause,
      }),
  });

  const resolvedServerDependencies = yield* Effect.try({
    try: () =>
      resolveCatalogDependencies(
        Object.fromEntries(
          Object.entries(serverDependencies).filter(
            ([, version]) => !(typeof version === "string" && version.startsWith("workspace:")),
          ),
        ),
        rootPackageJson.workspaces.catalog,
        "apps/server",
      ),
    catch: (cause) =>
      new BuildScriptError({
        message: "Could not resolve production dependencies from apps/server/package.json.",
        cause,
      }),
  });
  const resolvedDesktopRuntimeDependencies = yield* Effect.try({
    try: () =>
      resolveDesktopRuntimeDependencies(
        desktopPackageJson.dependencies,
        rootPackageJson.workspaces.catalog,
      ),
    catch: (cause) =>
      new BuildScriptError({
        message: "Could not resolve desktop runtime dependencies from apps/desktop/package.json.",
        cause,
      }),
  });

  const appVersion = options.version ?? serverPackageJson.version;
  const hasSourceCommit = options.sourceCommit !== undefined;
  const hasLockfileSha256 = options.lockfileSha256 !== undefined;
  const exactProvenanceRequested =
    hasSourceCommit || hasLockfileSha256 || options.sourceTag !== undefined;
  if (exactProvenanceRequested && (!hasSourceCommit || !hasLockfileSha256 || !options.version)) {
    return yield* new BuildScriptError({
      message:
        "Exact release provenance requires an explicit build version, source commit, and lockfile SHA-256 together.",
    });
  }

  const resolvedCommitHash = resolveGitCommitHash(repoRoot);
  if (options.sourceCommit && !/^[0-9a-f]{40}$/i.test(options.sourceCommit)) {
    return yield* new BuildScriptError({
      message: `Expected a full 40-character source commit, got '${options.sourceCommit}'.`,
    });
  }
  if (options.sourceCommit && resolvedCommitHash !== options.sourceCommit.toLowerCase()) {
    return yield* new BuildScriptError({
      message: `Release source commit mismatch: expected ${options.sourceCommit}, got ${resolvedCommitHash ?? "unknown"}.`,
    });
  }
  const commitHash = resolvedCommitHash ?? "unknown";
  const resolvedLockfileSha256 = resolveLockfileSha256(repoRoot);
  if (options.lockfileSha256 && !/^[0-9a-f]{64}$/i.test(options.lockfileSha256)) {
    return yield* new BuildScriptError({
      message: `Expected a 64-character lockfile SHA-256, got '${options.lockfileSha256}'.`,
    });
  }
  if (options.lockfileSha256 && resolvedLockfileSha256 !== options.lockfileSha256.toLowerCase()) {
    return yield* new BuildScriptError({
      message: `Release lockfile digest mismatch: expected ${options.lockfileSha256}, got ${resolvedLockfileSha256}.`,
    });
  }
  if (options.sourceTag && options.sourceTag !== `v${appVersion}`) {
    return yield* new BuildScriptError({
      message: `Release source tag ${options.sourceTag} does not match artifact version ${appVersion}.`,
    });
  }
  if (exactProvenanceRequested) {
    const gitStatus = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (gitStatus.status !== 0) {
      return yield* new BuildScriptError({
        message: `Unable to inspect release worktree: ${gitStatus.stderr.trim() || "git failed"}.`,
      });
    }
    if (gitStatus.stdout.trim().length > 0) {
      return yield* new BuildScriptError({
        message: "Release source worktree is not clean; refusing to stage uncommitted bytes.",
      });
    }
  }
  const mkdir = options.keepStage ? fs.makeTempDirectory : fs.makeTempDirectoryScoped;
  const stageRoot = yield* mkdir({
    prefix: `penkra-desktop-${options.platform}-stage-`,
  });

  const stageAppDir = path.join(stageRoot, "app");
  const stageResourcesDir = path.join(stageAppDir, "apps/desktop/resources");
  const configuredAppsPackagePath = process.env[PENKRA_APPS_PACKAGE_PATH_ENV]?.trim();
  const firstPartyAppsPackagePath = configuredAppsPackagePath
    ? path.resolve(configuredAppsPackagePath)
    : path.resolve(repoRoot, "..", "penkra-apps", "apps");
  const firstPartyAppsRoot = path.dirname(firstPartyAppsPackagePath);
  const firstPartyAppDirectories = ["apps", "explorer", "browser"] as const;
  const distDirs = {
    desktopDist: path.join(repoRoot, "apps/desktop/dist-electron"),
    desktopResources: path.join(repoRoot, "apps/desktop/resources"),
    serverDist: path.join(repoRoot, "apps/server/dist"),
  };
  const bundledClientEntry = path.join(distDirs.serverDist, "client/index.html");

  if (!options.skipBuild) {
    yield* Effect.log("[desktop-artifact] Building desktop/server/web artifacts...");
    yield* runCommand(
      ChildProcess.make({
        cwd: repoRoot,
        ...commandOutputOptions(options.verbose),
      })`bun run build:desktop`,
    );
  }

  for (const [label, dir] of Object.entries(distDirs)) {
    if (!(yield* fs.exists(dir))) {
      return yield* new BuildScriptError({
        message: `Missing ${label} at ${dir}. Run 'bun run build:desktop' first.`,
      });
    }
  }

  if (!(yield* fs.exists(bundledClientEntry))) {
    return yield* new BuildScriptError({
      message: `Missing bundled server client at ${bundledClientEntry}. Run 'bun run build:desktop' first.`,
    });
  }
  for (const directory of firstPartyAppDirectories) {
    const packagePath =
      directory === "apps" ? firstPartyAppsPackagePath : path.join(firstPartyAppsRoot, directory);
    if (!(yield* fs.exists(path.join(packagePath, "penkra-app.json")))) {
      return yield* new BuildScriptError({
        message: `Missing bundled ${directory} App package at ${packagePath}. Set ${PENKRA_APPS_PACKAGE_PATH_ENV} to the Apps folder in a complete penkra-apps checkout or artifact.`,
      });
    }
  }
  yield* validateBundledClientAssets(path.dirname(bundledClientEntry));

  yield* fs.makeDirectory(path.join(stageAppDir, "apps/desktop"), { recursive: true });
  yield* fs.makeDirectory(path.join(stageAppDir, "apps/server"), { recursive: true });

  yield* Effect.log("[desktop-artifact] Staging release app...");
  yield* fs.copy(distDirs.desktopDist, path.join(stageAppDir, "apps/desktop/dist-electron"));
  yield* fs.copy(distDirs.desktopResources, stageResourcesDir);
  yield* fs.copy(distDirs.serverDist, path.join(stageAppDir, "apps/server/dist"));
  for (const directory of firstPartyAppDirectories) {
    const packagePath =
      directory === "apps" ? firstPartyAppsPackagePath : path.join(firstPartyAppsRoot, directory);
    yield* fs.copy(packagePath, path.join(stageAppDir, `penkra-apps/${directory}`));
  }
  yield* assertPlatformBuildResources(options.platform, stageResourcesDir, options.verbose);

  // electron-builder is filtering out stageResourcesDir directory in the AppImage for production
  yield* fs.copy(stageResourcesDir, path.join(stageAppDir, "apps/desktop/prod-resources"));

  const codeSigned = options.signed || options.localSign;
  const resolvedBuildConfig = yield* createBuildConfig(
    options.platform,
    options.target,
    desktopPackageJson.productName ?? "Penkra",
    codeSigned,
    options.signed,
    options.mockUpdates,
    options.mockUpdateServerPort,
  );

  const stagePackageJson: StagePackageJson = {
    name: "penkra-desktop",
    version: appVersion,
    buildVersion: appVersion,
    penkraCommitHash: commitHash,
    penkraLockfileSha256: resolvedLockfileSha256,
    penkraSourceTag: options.sourceTag ?? null,
    private: true,
    description: "Penkra desktop build",
    author: "Penkra",
    main: "apps/desktop/dist-electron/main.js",
    build: resolvedBuildConfig,
    dependencies: {
      ...resolvedServerDependencies,
      ...resolvedDesktopRuntimeDependencies,
    },
    devDependencies: {
      electron: electronVersion,
    },
    overrides: {
      ...resolvedOverrides,
    },
  };

  yield* installFrozenStageDependencies(repoRoot, stageAppDir, options.verbose);

  // Penkra invokes the user's installed Claude CLI. The SDK's optional platform
  // package is a complete second Claude binary and must not ship in the app.
  const unusedClaudePlatformPackageName = resolveUnusedClaudePlatformPackageName(
    options.platform,
    options.arch,
  );
  const stagedClaudePlatformPackage = unusedClaudePlatformPackageName
    ? path.join(stageAppDir, "node_modules", "@anthropic-ai", unusedClaudePlatformPackageName)
    : null;
  if (stagedClaudePlatformPackage && (yield* fs.exists(stagedClaudePlatformPackage))) {
    yield* fs.remove(stagedClaudePlatformPackage, { recursive: true });
    yield* Effect.log(
      `[desktop-artifact] Removed unused staged Claude platform binary (${path.basename(stagedClaudePlatformPackage)}).`,
    );
  }
  if (stagedClaudePlatformPackage && (yield* fs.exists(stagedClaudePlatformPackage))) {
    return yield* new BuildScriptError({
      message: `Unused Claude platform binary remained in the staged app: ${stagedClaudePlatformPackage}`,
    });
  }

  const stagePackageJsonString = yield* encodeJsonString(stagePackageJson);
  yield* fs.writeFileString(path.join(stageAppDir, "package.json"), `${stagePackageJsonString}\n`);

  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
  };
  for (const [key, value] of Object.entries(buildEnv)) {
    if (value === "") {
      delete buildEnv[key];
    }
  }
  if (!codeSigned) {
    buildEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    delete buildEnv.CSC_LINK;
    delete buildEnv.CSC_KEY_PASSWORD;
    delete buildEnv.APPLE_API_KEY;
    delete buildEnv.APPLE_API_KEY_ID;
    delete buildEnv.APPLE_API_ISSUER;
  }

  yield* Effect.log(
    `[desktop-artifact] Building ${options.platform}/${options.target} (arch=${options.arch}, version=${appVersion})...`,
  );
  const electronBuilderCliPath = requireFromScriptsWorkspace.resolve("electron-builder/cli.js");
  yield* runCommand(
    ChildProcess.make({
      cwd: stageAppDir,
      env: buildEnv,
      ...commandOutputOptions(options.verbose),
    })`${process.execPath} ${electronBuilderCliPath} ${platformConfig.cliFlag} --${options.arch} --publish never`,
  );

  const stageDistDir = path.join(stageAppDir, "dist");
  if (!(yield* fs.exists(stageDistDir))) {
    return yield* new BuildScriptError({
      message: `Build completed but dist directory was not found at ${stageDistDir}`,
    });
  }

  if (options.target === "dmg" && options.signed) {
    yield* Effect.log("[desktop-artifact] Notarizing and validating signed macOS DMG...");
    const finalizedDmg = yield* Effect.try({
      try: () =>
        finalizeSignedMacDmg({
          stageDistDir,
          appleApiKey: buildEnv.APPLE_API_KEY,
          appleApiKeyId: buildEnv.APPLE_API_KEY_ID,
          appleApiIssuer: buildEnv.APPLE_API_ISSUER,
          verbose: options.verbose,
        }),
      catch: (cause) =>
        new BuildScriptError({
          message: "macOS DMG signing/notarization finalization failed.",
          cause,
        }),
    });
    yield* Effect.log(
      `[desktop-artifact] Signed and notarized macOS DMG (${finalizedDmg.dmgFileName}).`,
    );
  }

  yield* Effect.log("[desktop-artifact] Repacking and validating macOS update zip...");
  const finalizedZip = yield* Effect.tryPromise({
    try: () =>
      finalizeMacUpdateZip({
        stageDistDir,
        signed: codeSigned,
        verbose: options.verbose,
      }),
    catch: (cause) =>
      new BuildScriptError({
        message: "macOS update zip finalization failed.",
        cause,
      }),
  });
  yield* Effect.log(
    `[desktop-artifact] Regenerated macOS differential blockmap (${path.basename(finalizedZip.blockmapPath)}, ${finalizedZip.blockmapSize} bytes).`,
  );

  const stageEntries = yield* fs.readDirectory(stageDistDir);
  yield* fs.makeDirectory(options.outputDir, { recursive: true });

  const copiedArtifacts: string[] = [];
  for (const entry of stageEntries) {
    const isReleaseArtifact =
      entry === "latest-mac.yml" ||
      entry.endsWith(".dmg") ||
      entry.endsWith(".zip") ||
      entry.endsWith(".zip.blockmap");
    if (!isReleaseArtifact) continue;
    const from = path.join(stageDistDir, entry);
    const stat = yield* fs.stat(from).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!stat || stat.type !== "File") continue;

    const outputEntry =
      options.arch !== "arm64" && entry === "latest-mac.yml"
        ? `latest-mac-${options.arch}.yml`
        : entry;
    const to = path.join(options.outputDir, outputEntry);
    yield* fs.copyFile(from, to);
    copiedArtifacts.push(to);
  }

  if (copiedArtifacts.length === 0) {
    return yield* new BuildScriptError({
      message: `Build completed but no files were produced in ${stageDistDir}`,
    });
  }

  yield* Effect.log("[desktop-artifact] Done. Artifacts:").pipe(
    Effect.annotateLogs({ artifacts: copiedArtifacts }),
  );
});

const buildDesktopArtifactCli = Command.make("build-desktop-artifact", {
  platform: Flag.choice("platform", BuildPlatform.literals).pipe(
    Flag.withDescription("Build platform (env: PENKRA_DESKTOP_PLATFORM)."),
    Flag.optional,
  ),
  target: Flag.string("target").pipe(
    Flag.withDescription("Artifact target, for example dmg (env: PENKRA_DESKTOP_TARGET)."),
    Flag.optional,
  ),
  arch: Flag.choice("arch", BuildArch.literals).pipe(
    Flag.withDescription("Build arch, for example arm64/x64/universal (env: PENKRA_DESKTOP_ARCH)."),
    Flag.optional,
  ),
  buildVersion: Flag.string("build-version").pipe(
    Flag.withDescription("Artifact version metadata (env: PENKRA_DESKTOP_VERSION)."),
    Flag.optional,
  ),
  sourceCommit: Flag.string("source-commit").pipe(
    Flag.withDescription("Expected full source commit (env: PENKRA_SOURCE_COMMIT)."),
    Flag.optional,
  ),
  sourceTag: Flag.string("source-tag").pipe(
    Flag.withDescription("Exact source tag when building a release (env: PENKRA_SOURCE_TAG)."),
    Flag.optional,
  ),
  lockfileSha256: Flag.string("lockfile-sha256").pipe(
    Flag.withDescription("Expected bun.lock SHA-256 (env: PENKRA_LOCKFILE_SHA256)."),
    Flag.optional,
  ),
  outputDir: Flag.string("output-dir").pipe(
    Flag.withDescription("Output directory for artifacts (env: PENKRA_DESKTOP_OUTPUT_DIR)."),
    Flag.optional,
  ),
  skipBuild: Flag.boolean("skip-build").pipe(
    Flag.withDescription(
      "Skip `bun run build:desktop` and use existing dist artifacts (env: PENKRA_DESKTOP_SKIP_BUILD).",
    ),
    Flag.optional,
  ),
  keepStage: Flag.boolean("keep-stage").pipe(
    Flag.withDescription("Keep temporary staging files (env: PENKRA_DESKTOP_KEEP_STAGE)."),
    Flag.optional,
  ),
  signed: Flag.boolean("signed").pipe(
    Flag.withDescription(
      "Enable macOS signing and notarization discovery (env: PENKRA_DESKTOP_SIGNED).",
    ),
    Flag.optional,
  ),
  localSign: Flag.boolean("local-sign").pipe(
    Flag.withDescription(
      "Sign with the production Developer ID identity without notarizing (env: PENKRA_DESKTOP_LOCAL_SIGN).",
    ),
    Flag.optional,
  ),
  verbose: Flag.boolean("verbose").pipe(
    Flag.withDescription("Stream subprocess stdout (env: PENKRA_DESKTOP_VERBOSE)."),
    Flag.optional,
  ),
  mockUpdates: Flag.boolean("mock-updates").pipe(
    Flag.withDescription("Enable mock updates (env: PENKRA_DESKTOP_MOCK_UPDATES)."),
    Flag.optional,
  ),
  mockUpdateServerPort: Flag.string("mock-update-server-port").pipe(
    Flag.withDescription("Mock update server port (env: PENKRA_DESKTOP_MOCK_UPDATE_SERVER_PORT)."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Build a macOS desktop artifact for Penkra."),
  Command.withHandler((input) => Effect.flatMap(resolveBuildOptions(input), buildDesktopArtifact)),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

Command.run(buildDesktopArtifactCli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide(cliRuntimeLayer),
  NodeRuntime.runMain,
);
