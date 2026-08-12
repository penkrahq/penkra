import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveProviderBinary } from "./managedProviderRuntime";
import { installManagedProviderArtifact } from "./managedProviderArtifactInstaller";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed provider artifact installation", () => {
  it("verifies and activates a raw official artifact without a package manager", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "penkra-managed-artifact-"));
    roots.push(stateDir);
    const bytes = Buffer.from("#!/bin/sh\necho 'claude 2.1.226'\n");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const runCommand = vi.fn(() =>
      Effect.succeed({ stdout: "2.1.226 (Claude Code)\n", stderr: "", exitCode: 0 }),
    );

    const result = await Effect.runPromise(
      installManagedProviderArtifact(
        {
          stateDir,
          artifact: {
            provider: "claudeAgent",
            version: "2.1.226",
            platform: "darwin",
            architecture: "arm64",
            url: "https://downloads.claude.ai/example/claude",
            sha256,
            assetName: "claude",
            archive: "raw",
            executableRelativePath: "claude",
            metadataUrl: "https://downloads.claude.ai/example/manifest.json",
            source: "anthropic-release-manifest",
          },
          adapterVersion: "1",
          protocolVersion: "claude-agent-sdk-0.3",
          installedAt: "2026-08-08T00:00:00.000Z",
        },
        {
          download: ({ destination }) =>
            Effect.tryPromise({
              try: () => writeFile(destination, bytes, { flag: "wx", mode: 0o600 }),
              catch: (cause) => cause as Error,
            }),
          runCommand,
        },
      ).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(result.reused).toBe(false);
    expect(runCommand).toHaveBeenCalledTimes(1);
    const manifest = JSON.parse(
      await readFile(
        join(stateDir, "provider-runtimes/claudeAgent/versions/2.1.226/managed-runtime.json"),
        "utf8",
      ),
    );
    expect(manifest).toMatchObject({
      provider: "claudeAgent",
      version: "2.1.226",
      adapterVersion: "1",
      artifact: { sha256, integrity: "verified" },
    });

    const resolved = await Effect.runPromise(
      resolveProviderBinary({
        stateDir,
        provider: "claudeAgent",
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(resolved).toMatchObject({ ownership: "managed", version: "2.1.226" });
  });

  it("fails before activation when the artifact checksum differs", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "penkra-managed-artifact-bad-"));
    roots.push(stateDir);
    const runCommand = vi.fn(() => Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }));

    await expect(
      Effect.runPromise(
        installManagedProviderArtifact(
          {
            stateDir,
            artifact: {
              provider: "claudeAgent",
              version: "2.1.226",
              platform: "darwin",
              architecture: "arm64",
              url: "https://downloads.claude.ai/example/claude",
              sha256: "0".repeat(64),
              assetName: "claude",
              archive: "raw",
              executableRelativePath: "claude",
              metadataUrl: "https://downloads.claude.ai/example/manifest.json",
              source: "anthropic-release-manifest",
            },
            adapterVersion: "1",
            protocolVersion: "claude-agent-sdk-0.3",
          },
          {
            download: ({ destination }) =>
              Effect.tryPromise({
                try: () => writeFile(destination, "not the expected artifact", { flag: "wx" }),
                catch: (cause) => cause as Error,
              }),
            runCommand,
          },
        ).pipe(Effect.provide(NodeServices.layer)),
      ),
    ).rejects.toThrow("checksum mismatch");
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("replaces a corrupt immutable generation from the verified artifact", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "penkra-managed-artifact-repair-"));
    roots.push(stateDir);
    const versionDirectory = join(stateDir, "provider-runtimes/claudeAgent/versions/2.1.226");
    await mkdir(versionDirectory, { recursive: true });
    await writeFile(join(versionDirectory, "claude"), "corrupt");
    const bytes = Buffer.from("#!/bin/sh\necho 'claude 2.1.226'\n");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const runCommand = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed({ stdout: "claude 0.0.0\n", stderr: "", exitCode: 0 }))
      .mockReturnValueOnce(Effect.succeed({ stdout: "claude 2.1.226\n", stderr: "", exitCode: 0 }));

    const result = await Effect.runPromise(
      installManagedProviderArtifact(
        {
          stateDir,
          artifact: {
            provider: "claudeAgent",
            version: "2.1.226",
            platform: "darwin",
            architecture: "arm64",
            url: "https://downloads.claude.ai/example/claude",
            sha256,
            assetName: "claude",
            archive: "raw",
            executableRelativePath: "claude",
            metadataUrl: "https://downloads.claude.ai/example/manifest.json",
            source: "anthropic-release-manifest",
          },
          adapterVersion: "1",
          protocolVersion: "claude-agent-sdk-0.3",
        },
        {
          download: ({ destination }) =>
            Effect.tryPromise({
              try: () => writeFile(destination, bytes, { flag: "wx", mode: 0o600 }),
              catch: (cause) => cause as Error,
            }),
          runCommand,
        },
      ).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(result.reused).toBe(false);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(await readFile(join(versionDirectory, "claude"), "utf8")).toEqual(bytes.toString());
  });
});
