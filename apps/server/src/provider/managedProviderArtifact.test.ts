import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
  detectManagedProviderPlatform,
  resolveManagedProviderArtifact,
  type ManagedProviderArtifactFetch,
} from "./managedProviderArtifact";

function jsonResponse(value: unknown): Pick<Response, "ok" | "status" | "json" | "text"> {
  return {
    ok: true,
    status: 200,
    json: async () => value,
    text: async () => JSON.stringify(value),
  };
}

describe("managed provider artifact resolution", () => {
  it("selects deterministic x64 baseline and Linux libc targets", () => {
    expect(
      detectManagedProviderPlatform({
        platform: "linux",
        arch: "x64",
        glibcVersionRuntime: "2.39",
      }),
    ).toEqual({ platform: "linux", arch: "x64", baseline: true, libc: "glibc" });
    expect(
      detectManagedProviderPlatform({
        platform: "linux",
        arch: "x64",
        glibcVersionRuntime: null,
      }),
    ).toEqual({ platform: "linux", arch: "x64", baseline: true, libc: "musl" });
  });

  it("selects the exact checksummed Codex package for the platform", async () => {
    const fetch: ManagedProviderArtifactFetch = async () =>
      jsonResponse({
        tag_name: "rust-v0.147.0",
        assets: [
          {
            name: "codex-package-aarch64-apple-darwin.tar.gz",
            digest: `sha256:${"a".repeat(64)}`,
            browser_download_url: "https://example.invalid/codex.tar.gz",
          },
        ],
      });

    const artifact = await Effect.runPromise(
      resolveManagedProviderArtifact({
        provider: "codex",
        platform: { platform: "darwin", arch: "arm64" },
        fetch,
      }),
    );

    expect(artifact).toMatchObject({
      provider: "codex",
      version: "0.147.0",
      assetName: "codex-package-aarch64-apple-darwin.tar.gz",
      executableRelativePath: "bin/codex",
      sha256: "a".repeat(64),
    });
  });

  it("uses Claude's exact manifest checksum and raw platform binary", async () => {
    const fetch: ManagedProviderArtifactFetch = async (url) => {
      if (url.endsWith("/latest")) {
        return {
          ok: true,
          status: 200,
          json: async () => "2.1.211",
          text: async () => "2.1.211\n",
        };
      }
      return jsonResponse({
        platforms: { "darwin-arm64": { checksum: "b".repeat(64) } },
      });
    };

    const artifact = await Effect.runPromise(
      resolveManagedProviderArtifact({
        provider: "claudeAgent",
        platform: { platform: "darwin", arch: "arm64" },
        fetch,
      }),
    );

    expect(artifact).toMatchObject({
      provider: "claudeAgent",
      version: "2.1.211",
      archive: "raw",
      executableRelativePath: "claude",
      sha256: "b".repeat(64),
    });
  });

  it("selects OpenCode's musl baseline artifact without name heuristics", async () => {
    const assetName = "opencode-linux-x64-baseline-musl.tar.gz";
    const fetch: ManagedProviderArtifactFetch = async () =>
      jsonResponse({
        tag_name: "v1.18.15",
        assets: [
          {
            name: assetName,
            digest: `sha256:${"c".repeat(64)}`,
            browser_download_url: "https://example.invalid/opencode.tar.gz",
          },
        ],
      });

    const artifact = await Effect.runPromise(
      resolveManagedProviderArtifact({
        provider: "opencode",
        platform: { platform: "linux", arch: "x64", libc: "musl", baseline: true },
        fetch,
      }),
    );

    expect(artifact).toMatchObject({
      provider: "opencode",
      version: "1.18.15",
      assetName,
      archive: "tar.gz",
      executableRelativePath: "opencode",
      sha256: "c".repeat(64),
    });
  });

  it("fails closed when official metadata omits the selected artifact digest", async () => {
    const fetch: ManagedProviderArtifactFetch = async () =>
      jsonResponse({
        tag_name: "v1.18.15",
        assets: [
          {
            name: "opencode-darwin-arm64.zip",
            digest: null,
            browser_download_url: "https://example.invalid/opencode.zip",
          },
        ],
      });

    await expect(
      Effect.runPromise(
        resolveManagedProviderArtifact({
          provider: "opencode",
          platform: { platform: "darwin", arch: "arm64" },
          fetch,
        }),
      ),
    ).rejects.toThrow("no SHA-256 digest");
  });
});
