// FILE: managedProviderArtifact.ts
// Purpose: Resolves immutable official provider artifacts without consulting PATH or package managers.

import type { ProviderKind } from "@penkra/contracts";
import { Effect } from "effect";

const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export type ManagedProviderArchiveKind = "raw" | "tar.gz" | "zip";

export interface ManagedProviderArtifact {
  readonly provider: ProviderKind;
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly url: string;
  readonly sha256: string;
  readonly assetName: string;
  readonly archive: ManagedProviderArchiveKind;
  readonly executableRelativePath: string;
  readonly metadataUrl: string;
  readonly source: "anthropic-release-manifest" | "github-release";
}

export interface ManagedProviderPlatform {
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly libc?: "glibc" | "musl";
  readonly baseline?: boolean;
}

export function detectManagedProviderPlatform(input?: {
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly glibcVersionRuntime?: string | null;
}): ManagedProviderPlatform {
  const platform = input?.platform ?? process.platform;
  const arch = input?.arch ?? process.arch;
  const report =
    platform === "linux" && input?.glibcVersionRuntime === undefined
      ? (process.report?.getReport() as {
          readonly header?: { readonly glibcVersionRuntime?: string };
        })
      : undefined;
  const glibcVersionRuntime = input?.glibcVersionRuntime ?? report?.header?.glibcVersionRuntime;
  return {
    platform,
    arch,
    // The baseline artifact is the deterministic x64 target. It avoids
    // speculating about AVX2 from processor names or inherited shell state.
    ...(arch === "x64" ? { baseline: true } : {}),
    ...(platform === "linux"
      ? { libc: glibcVersionRuntime ? ("glibc" as const) : ("musl" as const) }
      : {}),
  };
}

type FetchResponse = Pick<Response, "ok" | "status" | "json" | "text">;
export type ManagedProviderArtifactFetch = (
  url: string,
  init?: RequestInit,
) => Promise<FetchResponse>;

interface GitHubReleaseAsset {
  readonly name: string;
  readonly digest: string;
  readonly browserDownloadUrl: string;
}

interface GitHubRelease {
  readonly version: string;
  readonly metadataUrl: string;
  readonly assets: ReadonlyArray<GitHubReleaseAsset>;
}

function supportedArch(arch: NodeJS.Architecture): "arm64" | "x64" {
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "x64";
  throw new Error(`Unsupported provider runtime architecture '${arch}'.`);
}

function normalizeVersion(value: string, prefix = "v"): string {
  const trimmed = value.trim();
  const version = trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
  if (!VERSION.test(version)) {
    throw new Error(`Provider release returned invalid version '${trimmed}'.`);
  }
  return version;
}

function normalizedDigest(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("sha256:")) {
    throw new Error("Provider release asset has no SHA-256 digest.");
  }
  const digest = value.slice("sha256:".length).toLowerCase();
  if (!SHA256.test(digest)) {
    throw new Error("Provider release asset has an invalid SHA-256 digest.");
  }
  return digest;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Provider release metadata is not an object.");
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Provider release metadata is missing '${key}'.`);
  }
  return value.trim();
}

function githubMetadataUrl(repository: string, version: string): string {
  return version === "latest"
    ? `https://api.github.com/repos/${repository}/releases/latest`
    : `https://api.github.com/repos/${repository}/releases/tags/${
        repository === "openai/codex" ? `rust-v${version}` : `v${version}`
      }`;
}

function readGitHubRelease(input: {
  readonly repository: string;
  readonly version: string;
  readonly fetch: ManagedProviderArtifactFetch;
}) {
  return Effect.tryPromise({
    try: async (): Promise<GitHubRelease> => {
      const metadataUrl = githubMetadataUrl(input.repository, input.version);
      const response = await input.fetch(metadataUrl, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Penkra",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (!response.ok) {
        throw new Error(`Provider release metadata request failed with HTTP ${response.status}.`);
      }
      const record = asRecord(await response.json());
      const tag = requiredString(record, "tag_name");
      const version = normalizeVersion(tag, input.repository === "openai/codex" ? "rust-v" : "v");
      if (input.version !== "latest" && version !== input.version) {
        throw new Error(
          `Provider release metadata returned ${version}, expected ${input.version}.`,
        );
      }
      if (!Array.isArray(record.assets)) {
        throw new Error("Provider release metadata is missing assets.");
      }
      const assets = record.assets.map((rawAsset): GitHubReleaseAsset => {
        const asset = asRecord(rawAsset);
        return {
          name: requiredString(asset, "name"),
          digest: normalizedDigest(asset.digest),
          browserDownloadUrl: requiredString(asset, "browser_download_url"),
        };
      });
      return { version, metadataUrl, assets };
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
}

function selectGitHubAsset(release: GitHubRelease, assetName: string): GitHubReleaseAsset {
  const asset = release.assets.find((candidate) => candidate.name === assetName);
  if (!asset) {
    throw new Error(`Provider release ${release.version} has no '${assetName}' artifact.`);
  }
  return asset;
}

function resolveCodexTarget(platform: ManagedProviderPlatform): string {
  const arch = supportedArch(platform.arch) === "arm64" ? "aarch64" : "x86_64";
  if (platform.platform === "darwin") return `${arch}-apple-darwin`;
  if (platform.platform === "linux") return `${arch}-unknown-linux-musl`;
  if (platform.platform === "win32") return `${arch}-pc-windows-msvc`;
  throw new Error(`Codex has no managed artifact for '${platform.platform}'.`);
}

function resolveCodexArtifact(input: {
  readonly version: string;
  readonly platform: ManagedProviderPlatform;
  readonly fetch: ManagedProviderArtifactFetch;
}) {
  return Effect.gen(function* () {
    const release = yield* readGitHubRelease({
      repository: "openai/codex",
      version: input.version,
      fetch: input.fetch,
    });
    const target = resolveCodexTarget(input.platform);
    const assetName = `codex-package-${target}.tar.gz`;
    const asset = selectGitHubAsset(release, assetName);
    return {
      provider: "codex",
      version: release.version,
      platform: input.platform.platform,
      architecture: input.platform.arch,
      url: asset.browserDownloadUrl,
      sha256: asset.digest,
      assetName,
      archive: "tar.gz",
      executableRelativePath: input.platform.platform === "win32" ? "bin/codex.exe" : "bin/codex",
      metadataUrl: release.metadataUrl,
      source: "github-release",
    } satisfies ManagedProviderArtifact;
  });
}

function resolveOpenCodeAssetName(platform: ManagedProviderPlatform): string {
  const arch = supportedArch(platform.arch);
  const baseline = arch === "x64" && platform.baseline === true ? "-baseline" : "";
  if (platform.platform === "darwin") return `opencode-darwin-${arch}${baseline}.zip`;
  if (platform.platform === "win32") return `opencode-windows-${arch}${baseline}.zip`;
  if (platform.platform === "linux") {
    const libc = platform.libc === "musl" ? "-musl" : "";
    return `opencode-linux-${arch}${baseline}${libc}.tar.gz`;
  }
  throw new Error(`OpenCode has no managed artifact for '${platform.platform}'.`);
}

function resolveOpenCodeArtifact(input: {
  readonly version: string;
  readonly platform: ManagedProviderPlatform;
  readonly fetch: ManagedProviderArtifactFetch;
}) {
  return Effect.gen(function* () {
    const release = yield* readGitHubRelease({
      repository: "anomalyco/opencode",
      version: input.version,
      fetch: input.fetch,
    });
    const assetName = resolveOpenCodeAssetName(input.platform);
    const asset = selectGitHubAsset(release, assetName);
    return {
      provider: "opencode",
      version: release.version,
      platform: input.platform.platform,
      architecture: input.platform.arch,
      url: asset.browserDownloadUrl,
      sha256: asset.digest,
      assetName,
      archive: assetName.endsWith(".zip") ? "zip" : "tar.gz",
      executableRelativePath: input.platform.platform === "win32" ? "opencode.exe" : "opencode",
      metadataUrl: release.metadataUrl,
      source: "github-release",
    } satisfies ManagedProviderArtifact;
  });
}

function resolveClaudePlatform(platform: ManagedProviderPlatform): string {
  const arch = supportedArch(platform.arch);
  if (platform.platform === "darwin") return `darwin-${arch}`;
  if (platform.platform === "win32") return `win32-${arch}`;
  if (platform.platform === "linux") {
    return `linux-${arch}${platform.libc === "musl" ? "-musl" : ""}`;
  }
  throw new Error(`Claude has no managed artifact for '${platform.platform}'.`);
}

function resolveClaudeArtifact(input: {
  readonly version: string;
  readonly platform: ManagedProviderPlatform;
  readonly fetch: ManagedProviderArtifactFetch;
}) {
  return Effect.tryPromise({
    try: async (): Promise<ManagedProviderArtifact> => {
      const baseUrl = "https://downloads.claude.ai/claude-code-releases";
      let resolvedVersion: string;
      if (input.version === "latest") {
        const latestResponse = await input.fetch(`${baseUrl}/latest`);
        if (!latestResponse.ok) {
          throw new Error(
            `Claude latest-version request failed with HTTP ${latestResponse.status}.`,
          );
        }
        resolvedVersion = normalizeVersion(await latestResponse.text(), "v");
      } else {
        resolvedVersion = normalizeVersion(input.version, "v");
      }
      const metadataUrl = `${baseUrl}/${resolvedVersion}/manifest.json`;
      const response = await input.fetch(metadataUrl);
      if (!response.ok) {
        throw new Error(`Claude release manifest request failed with HTTP ${response.status}.`);
      }
      const manifest = asRecord(await response.json());
      const platforms = asRecord(manifest.platforms);
      const platformName = resolveClaudePlatform(input.platform);
      const platform = asRecord(platforms[platformName]);
      const sha256 = requiredString(platform, "checksum").toLowerCase();
      if (!SHA256.test(sha256)) {
        throw new Error(`Claude release manifest has an invalid checksum for '${platformName}'.`);
      }
      const executable = input.platform.platform === "win32" ? "claude.exe" : "claude";
      return {
        provider: "claudeAgent",
        version: resolvedVersion,
        platform: input.platform.platform,
        architecture: input.platform.arch,
        url: `${baseUrl}/${resolvedVersion}/${platformName}/${executable}`,
        sha256,
        assetName: executable,
        archive: "raw",
        executableRelativePath: executable,
        metadataUrl,
        source: "anthropic-release-manifest",
      };
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
}

export function resolveManagedProviderArtifact(input: {
  readonly provider: ProviderKind;
  readonly version?: string;
  readonly platform?: ManagedProviderPlatform;
  readonly fetch?: ManagedProviderArtifactFetch;
}) {
  const version = input.version?.trim() || "latest";
  if (version !== "latest" && !VERSION.test(version)) {
    return Effect.fail(new Error(`Invalid managed provider version '${version}'.`));
  }
  const platform = input.platform ?? detectManagedProviderPlatform();
  const fetcher = input.fetch ?? globalThis.fetch;
  switch (input.provider) {
    case "codex":
      return resolveCodexArtifact({ version, platform, fetch: fetcher });
    case "claudeAgent":
      return resolveClaudeArtifact({ version, platform, fetch: fetcher });
    case "opencode":
      return resolveOpenCodeArtifact({ version, platform, fetch: fetcher });
    default:
      return Effect.fail(
        new Error(`Provider '${input.provider}' has no managed artifact adapter.`),
      );
  }
}
