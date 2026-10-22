import { DEFAULT_SERVER_SETTINGS, type ProviderInstallation } from "@penkra/contracts";
import { Effect } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "vitest";
import type { ActivateProviderInstallationInput } from "../persistence/Services/ProviderInstallations.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { ensurePinnedProviderRuntimes } from "./ensurePinnedProviderRuntimes.ts";
import { PINNED_PROVIDER_RUNTIMES } from "./pinnedProviderRuntimes.ts";
import type {
  ManagedProviderArtifactInstallInput,
  ManagedProviderArtifactInstallResult,
  ManagedProviderGenerationManifest,
} from "./managedProviderArtifactInstaller.ts";
import { pinnedProviderArtifact, type PinnedProviderKind } from "./pinnedProviderRuntimes.ts";

function fixture() {
  const settings = structuredClone(DEFAULT_SERVER_SETTINGS);
  const install = vi.fn(
    (
      input: ManagedProviderArtifactInstallInput,
    ): Effect.Effect<ManagedProviderArtifactInstallResult, Error> =>
      Effect.succeed({
        binaryPath: `/managed/${input.artifact.provider}/${input.artifact.version}`,
        installationId: `installation-${input.artifact.provider}`,
        version: input.artifact.version,
        reused: false,
      }),
  );
  const activate = vi.fn(
    (
      input: ActivateProviderInstallationInput,
    ): Effect.Effect<ProviderInstallation, PersistenceSqlError> =>
      Effect.succeed({
        ...input,
        lifecycle: "active" as const,
        healthReason: null,
        retiredAt: null,
      }),
  );
  const deactivate = vi.fn(() => Effect.succeed(true));
  const readManifest = vi.fn((input: { provider: PinnedProviderKind }) => {
    const artifact = pinnedProviderArtifact(input.provider);
    const release = PINNED_PROVIDER_RUNTIMES.providers[input.provider];
    return Effect.succeed({
      schemaVersion: 1,
      provider: input.provider,
      installationId: `installation-${input.provider}`,
      version: release.version,
      platform: artifact.platform,
      architecture: artifact.architecture,
      adapterVersion: release.adapterVersion,
      protocolVersion: release.protocolVersion,
      executableRelativePath: artifact.executableRelativePath,
      installedAt: "2026-10-01T00:00:00.000Z",
      artifact: { ...artifact, integrity: "verified" },
    } satisfies ManagedProviderGenerationManifest);
  });
  const hasActiveProviderThread = vi.fn(() => Effect.succeed(false));
  return { settings, install, activate, deactivate, readManifest, hasActiveProviderThread };
}
function run(f: ReturnType<typeof fixture>) {
  return Effect.runPromise(
    ensurePinnedProviderRuntimes({
      stateDir: "/unused-pinned-fixture",
      settings: f.settings,
      threadReads: f,
      installations: f,
      install: f.install,
      deactivate: f.deactivate,
      readManifest: f.readManifest,
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

describe("pinned runtime startup", () => {
  it("installs only immutable manifest artifacts, and records their verified identity", async () => {
    const f = fixture();
    await run(f);
    expect(f.install).toHaveBeenCalledTimes(3);
    for (const [input] of f.install.mock.calls) {
      const release = PINNED_PROVIDER_RUNTIMES.providers[input.artifact.provider];
      expect(input.artifact.version).toBe(release.version);
      expect(Object.values(release.artifacts)).toContainEqual(input.artifact);
      expect(f.activate).toHaveBeenCalledWith(
        expect.objectContaining({
          harness: input.artifact.provider,
          version: release.version,
          artifactSha256: input.artifact.sha256,
          installedAt: "2026-10-01T00:00:00.000Z",
        }),
      );
    }
    expect(f.deactivate).not.toHaveBeenCalled();
  });
  it("does not touch a disabled provider", async () => {
    const f = fixture();
    f.settings = {
      ...f.settings,
      providers: {
        ...f.settings.providers,
        claudeAgent: { ...f.settings.providers.claudeAgent, enabled: false },
      },
    };
    await run(f);
    expect(f.install.mock.calls.map(([input]) => input.artifact.provider)).toEqual([
      "codex",
      "opencode",
    ]);
  });
  it("defers an active provider without stopping it or blocking other providers", async () => {
    const f = fixture();
    f.hasActiveProviderThread.mockReturnValueOnce(Effect.succeed(true));
    await run(f);
    expect(f.install.mock.calls.map(([input]) => input.artifact.provider)).toEqual([
      "claudeAgent",
      "opencode",
    ]);
  });
  it("does not activate an unverified artifact or retry an installation failure", async () => {
    const f = fixture();
    f.install.mockReturnValueOnce(Effect.fail(new Error("checksum mismatch")));
    await expect(run(f)).rejects.toThrow("checksum mismatch");
    expect(f.install).toHaveBeenCalledTimes(1);
    expect(f.activate).not.toHaveBeenCalled();
  });
  it("removes the filesystem activation if durable registration fails", async () => {
    const f = fixture();
    f.activate.mockReturnValueOnce(
      Effect.fail(
        new PersistenceSqlError({ operation: "activate", detail: "registration failed" }),
      ),
    );
    await expect(run(f)).rejects.toThrow("registration failed");
    expect(f.deactivate).toHaveBeenCalledWith({
      stateDir: "/unused-pinned-fixture",
      provider: "codex",
      installationId: "installation-codex",
    });
    expect(f.install).toHaveBeenCalledTimes(1);
  });
});
