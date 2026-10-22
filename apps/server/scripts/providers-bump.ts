import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { writeFileStringAtomically } from "../src/atomicWrite.ts";
import {
  resolveManagedProviderArtifact,
  type ManagedProviderPlatform,
} from "../src/provider/managedProviderArtifact.ts";
import { installManagedProviderArtifact } from "../src/provider/managedProviderArtifactInstaller.ts";
import {
  PINNED_PROVIDER_KINDS,
  PROVIDER_RUNTIME_TARGETS,
  parseProviderRuntimeLock,
  type PinnedProviderKind,
} from "../src/provider/pinnedProviderRuntimes.ts";

const repository = path.resolve(import.meta.dirname, "../../..");
const exec = promisify(execFile);

function writeJson(filePath: string, value: unknown) {
  return Effect.runPromise(
    writeFileStringAtomically({ filePath, contents: JSON.stringify(value, null, 2) + "\n" }),
  );
}

export function bumpArguments(args: readonly string[]): {
  provider: PinnedProviderKind;
  version: string;
} {
  const [provider, version] = args;
  if (
    args.length !== 2 ||
    !PINNED_PROVIDER_KINDS.some((kind) => kind === provider) ||
    !version ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
  ) {
    throw new Error("Usage: bun run providers:bump <codex|claudeAgent|opencode> <exact-version>");
  }
  return { provider: provider as PinnedProviderKind, version };
}

export function targetPlatform(
  target: (typeof PROVIDER_RUNTIME_TARGETS)[number],
): ManagedProviderPlatform {
  const [platform, arch, libc] = target.split("-") as [
    "darwin" | "linux" | "win32",
    "arm64" | "x64",
    "glibc" | "musl" | undefined,
  ];
  return {
    platform,
    arch,
    ...(libc ? { libc } : {}),
    ...(arch === "x64" ? { baseline: true } : {}),
  };
}

async function registryMetadata(
  packageName: string,
  version?: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `https://registry.npmjs.org/${packageName}${version ? `/${version}` : ""}`,
  );
  if (!response.ok)
    throw new Error(
      `SDK metadata rejected: ${packageName} ${version ?? "versions"}, HTTP ${response.status}`,
    );
  return (await response.json()) as Record<string, unknown>;
}

/** Select only an official SDK explicitly declaring this exact Claude CLI. */
export function claudeSdkVersion(metadata: Record<string, unknown>, cliVersion: string): string {
  const versions = metadata.versions as
    | Record<string, { version?: string; claudeCodeVersion?: string }>
    | undefined;
  const matches = Object.values(versions ?? {}).filter(
    (entry) =>
      entry.claudeCodeVersion === cliVersion &&
      entry.version &&
      /^\d+\.\d+\.\d+$/.test(entry.version),
  );
  matches.sort((left, right) => {
    const a = left.version!.split(".").map(Number),
      b = right.version!.split(".").map(Number);
    return b[0]! - a[0]! || b[1]! - a[1]! || b[2]! - a[2]!;
  });
  if (!matches[0]?.version)
    throw new Error(`No official Claude Agent SDK declares CLI ${cliVersion}.`);
  return matches[0].version;
}

async function command(executable: string, args: string[], env = process.env) {
  const { stdout, stderr } = await exec(executable, args, {
    cwd: repository,
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
}

export async function bumpProvider(args: readonly string[]) {
  const { provider, version } = bumpArguments(args);
  const manifestPath = path.join(repository, "providerRuntimes.json");
  const originalManifest = await readFile(manifestPath, "utf8");
  const candidate = JSON.parse(originalManifest);
  const previous = parseProviderRuntimeLock(candidate).providers[provider];
  const metadataRequests = new Map<string, Promise<Response>>();
  const metadataFetch = async (url: string, init?: RequestInit) => {
    let pending = metadataRequests.get(url);
    if (!pending) {
      const headers = new Headers(init?.headers);
      const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
      if (token && new URL(url).hostname === "api.github.com")
        headers.set("Authorization", `Bearer ${token}`);
      pending = fetch(url, { ...init, headers });
      metadataRequests.set(url, pending);
    }
    return (await pending).clone();
  };
  const artifacts = Object.fromEntries(
    await Promise.all(
      PROVIDER_RUNTIME_TARGETS.map(async (target) => [
        target,
        await Effect.runPromise(
          resolveManagedProviderArtifact({
            provider,
            version,
            platform: targetPlatform(target),
            fetch: metadataFetch,
          }),
        ),
      ]),
    ),
  );
  const sdkVersion =
    provider === "claudeAgent"
      ? claudeSdkVersion(await registryMetadata("@anthropic-ai/claude-agent-sdk"), version)
      : provider === "opencode"
        ? version
        : undefined;
  if (provider === "opencode") await registryMetadata("@opencode-ai/sdk", version);
  candidate.providers[provider] = {
    ...previous,
    version,
    artifacts,
    ...(sdkVersion ? { sdkVersion } : {}),
  };
  parseProviderRuntimeLock(candidate);
  const scratchParent = path.join(repository, ".penkra/scratch/providers-bump");
  await mkdir(scratchParent, { recursive: true });
  const scratch = await mkdtemp(path.join(scratchParent, `${provider}-`));
  try {
    const { detectManagedProviderPlatform } =
      await import("../src/provider/managedProviderArtifact.ts");
    const native = detectManagedProviderPlatform();
    const target = [
      native.platform,
      native.arch,
      native.platform === "linux" ? native.libc : undefined,
    ]
      .filter(Boolean)
      .join("-");
    const artifact = artifacts[target];
    if (!artifact) throw new Error(`No native artifact for ${target}.`);
    const installed = await Effect.runPromise(
      installManagedProviderArtifact({
        stateDir: scratch,
        artifact,
        adapterVersion: previous.adapterVersion,
        protocolVersion: previous.protocolVersion,
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    if ((await readFile(manifestPath, "utf8")) !== originalManifest)
      throw new Error("The runtime manifest changed during preparation; no candidate was written.");
    await writeJson(manifestPath, candidate);
    if (sdkVersion) {
      const name =
        provider === "claudeAgent" ? "@anthropic-ai/claude-agent-sdk" : "@opencode-ai/sdk";
      for (const relative of provider === "claudeAgent"
        ? ["apps/server/package.json", "scripts/package.json"]
        : ["apps/server/package.json"]) {
        const file = path.join(repository, relative);
        const value = JSON.parse(await readFile(file, "utf8"));
        value.dependencies[name] = sdkVersion;
        await writeJson(file, value);
      }
      await command(process.execPath, ["install"]);
    }
    if (provider === "codex") {
      const generated = path.join(repository, "apps/server/src/provider/generated/codex");
      const changes = await exec(
        "git",
        ["status", "--porcelain", "--untracked-files=all", "--", generated],
        { cwd: repository },
      );
      if (changes.stdout.trim())
        throw new Error(
          "Commit or preserve pending generated-protocol edits before bumping Codex.",
        );
      await rm(generated, { recursive: true, force: true });
      await command(installed.binaryPath, [
        "app-server",
        "generate-ts",
        "--experimental",
        "--out",
        generated,
      ]);
      await command(process.execPath, ["run", "fmt", generated]);
    }
    const contracts =
      provider === "codex"
        ? ["codex.contract.ts"]
        : provider === "claudeAgent"
          ? ["claude.contract.ts"]
          : ["opencode.contract.ts", "opencode-lifecycle.contract.ts"];
    await command(
      process.execPath,
      [
        "run",
        "--cwd",
        "apps/server",
        "test",
        "--config",
        "provider-contracts.config.ts",
        ...contracts.map((name) => `integration/provider-contracts/${name}`),
      ],
      { ...process.env, PENKRA_CONTRACT_BINARY: installed.binaryPath },
    );
    console.log(
      `Verified ${provider}: ${previous.version} -> ${version}. Review and commit the candidate; nothing was published or activated in Penkra.`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) await bumpProvider(process.argv.slice(2));
