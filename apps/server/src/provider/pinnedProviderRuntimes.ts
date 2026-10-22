import { Schema } from "effect";
import path from "node:path";
import lock from "../../../../providerRuntimes.json" with { type: "json" };
import {
  detectManagedProviderPlatform,
  type ManagedProviderArtifact,
  type ManagedProviderPlatform,
} from "./managedProviderArtifact.ts";

export const PINNED_PROVIDER_KINDS = ["codex", "claudeAgent", "opencode"] as const;
export type PinnedProviderKind = (typeof PINNED_PROVIDER_KINDS)[number];
export const PROVIDER_RUNTIME_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "win32-arm64",
  "win32-x64",
  "linux-arm64-glibc",
  "linux-arm64-musl",
  "linux-x64-glibc",
  "linux-x64-musl",
] as const;

const version = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/));
const nonEmpty = Schema.String.check(Schema.isNonEmpty());
const artifact = Schema.Struct({
  provider: Schema.Literals(PINNED_PROVIDER_KINDS),
  version,
  platform: Schema.Literals(["darwin", "win32", "linux"]),
  architecture: Schema.Literals(["arm64", "x64"]),
  url: nonEmpty,
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  assetName: nonEmpty,
  archive: Schema.Literals(["raw", "tar.gz", "zip"]),
  executableRelativePath: nonEmpty,
  metadataUrl: nonEmpty,
  source: Schema.Literals(["github-release", "anthropic-release-manifest"]),
});
const runtime = Schema.Struct({
  version,
  adapterVersion: nonEmpty,
  protocolVersion: nonEmpty,
  artifacts: Schema.Record(Schema.Literals(PROVIDER_RUNTIME_TARGETS), artifact),
});
const manifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  providers: Schema.Struct({
    codex: runtime,
    claudeAgent: Schema.Struct({ ...runtime.fields, sdkVersion: version }),
    opencode: Schema.Struct({ ...runtime.fields, sdkVersion: version }),
  }),
});
export type ProviderRuntimeLock = typeof manifest.Type;

/** Validate the committed runtime versions and immutable artifact identities. */
export function parseProviderRuntimeLock(value: unknown): ProviderRuntimeLock {
  const parsed = Schema.decodeUnknownSync(manifest)(value);
  for (const provider of PINNED_PROVIDER_KINDS) {
    const entry = parsed.providers[provider];
    for (const target of PROVIDER_RUNTIME_TARGETS) {
      const item = entry.artifacts[target];
      const [platform, architecture] = target.split("-");
      if (
        !item ||
        item.provider !== provider ||
        item.version !== entry.version ||
        item.platform !== platform ||
        item.architecture !== architecture
      )
        throw new Error(`Pinned runtime identity does not match ${provider}/${target}.`);
      if (
        path.posix.isAbsolute(item.executableRelativePath) ||
        path.win32.isAbsolute(item.executableRelativePath) ||
        item.executableRelativePath.split(/[/\\]/).some((part) => part === ".." || part === "")
      )
        throw new Error(`Pinned executable escapes its generation: ${provider}/${target}.`);
      const prefix =
        provider === "claudeAgent"
          ? `https://downloads.claude.ai/claude-code-releases/${entry.version}/`
          : `https://github.com/${provider === "codex" ? "openai/codex" : "anomalyco/opencode"}/releases/download/${provider === "codex" ? "rust-v" : "v"}${entry.version}/`;
      const url = new URL(item.url);
      if (
        !url.href.startsWith(prefix) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        item.source !==
          (provider === "claudeAgent" ? "anthropic-release-manifest" : "github-release")
      )
        throw new Error(
          `Pinned artifact is not an official immutable release: ${provider}/${target}.`,
        );
    }
  }
  return parsed;
}

export const PINNED_PROVIDER_RUNTIMES = parseProviderRuntimeLock(lock);

export function pinnedProviderArtifact(
  provider: PinnedProviderKind,
  platform: ManagedProviderPlatform = detectManagedProviderPlatform(),
): ManagedProviderArtifact {
  const target = [
    platform.platform,
    platform.arch,
    platform.platform === "linux" ? platform.libc : undefined,
  ]
    .filter(Boolean)
    .join("-");
  const entry = PINNED_PROVIDER_RUNTIMES.providers[provider];
  const item = Object.entries(entry.artifacts).find(([key]) => key === target)?.[1];
  if (!item) throw new Error(`No pinned runtime for ${provider}/${target}.`);
  return item;
}
