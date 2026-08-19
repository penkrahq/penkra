import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProviderConnectionId } from "@penkra/contracts";
import { outboundHttp } from "@penkra/shared/outboundHttp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderConnectionRecord } from "../persistence/Services/ProviderConnections";
import { providerConnectionProfileRoot } from "../provider/providerNativeStatePaths";
import { __resetConnectionUsageCache, collectProviderConnectionUsageSnapshots } from "./index";

const timestamp = "2026-08-18T12:00:00.000Z";
const createdRoots: string[] = [];

function connection(input: {
  id: string;
  harness: ProviderConnectionRecord["harness"];
  target: string;
  method: string;
  profileRef?: string | null;
}): ProviderConnectionRecord {
  return {
    id: ProviderConnectionId.makeUnsafe(input.id),
    harness: input.harness,
    authenticationTargetId: input.target,
    authenticationMethodId: input.method,
    label: input.id,
    credentialRef: input.profileRef === undefined ? "credential-ref" : null,
    profileRef: input.profileRef ?? null,
    providerIdentityId: null,
    health: "ready",
    healthReason: null,
    lastCheckedAt: timestamp,
    lifecycle: "active",
    terminationReason: null,
    terminatedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function writeClaudeAccount(
  stateDir: string,
  profileIdentity: string,
  accessToken: string,
): Promise<void> {
  const root = providerConnectionProfileRoot(stateDir, profileIdentity);
  const configDir = path.join(root, "claude-config");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken,
        refreshToken: `${accessToken}-refresh`,
        expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
        scopes: ["user:profile"],
      },
    }),
  );
}

describe("Connection-scoped provider usage", () => {
  beforeEach(() => {
    __resetConnectionUsageCache();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await Promise.all(createdRoots.splice(0).map((root) => rm(root, { recursive: true })));
  });

  it("keeps two account profiles and their cached values isolated", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "penkra-connection-usage-"));
    createdRoots.push(stateDir);
    await writeClaudeAccount(stateDir, "account-a", "token-a");
    await writeClaudeAccount(stateDir, "account-b", "token-b");
    const fetchMock = vi.spyOn(outboundHttp, "request").mockImplementation(async (input) => {
      const authorization = new Headers(input.headers).get("authorization");
      const utilization = authorization === "Bearer token-a" ? 12 : 67;
      const body = new TextEncoder().encode(
        JSON.stringify({
          five_hour: { utilization, resets_at: "2099-01-01T01:00:00.000Z" },
        }),
      );
      return {
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        body,
        url: String(input.url),
      };
    });
    const connections = [
      connection({
        id: "connection-a",
        harness: "claudeAgent",
        target: "anthropic-first-party",
        method: "claude-account",
        profileRef: "provider-profile:account-a",
      }),
      connection({
        id: "connection-b",
        harness: "claudeAgent",
        target: "anthropic-first-party",
        method: "claude-account",
        profileRef: "provider-profile:account-b",
      }),
    ];
    const ctx = {
      homeDir: stateDir,
      env: {},
      platform: process.platform,
      nowMs: Date.parse(timestamp),
    } as const;

    const first = await collectProviderConnectionUsageSnapshots({ connections, stateDir, ctx });
    const second = await collectProviderConnectionUsageSnapshots({ connections, stateDir, ctx });

    expect(
      first.map((snapshot) => [snapshot.connectionId, snapshot.limits[0]?.usedPercent]),
    ).toEqual([
      [ProviderConnectionId.makeUnsafe("connection-a"), 12],
      [ProviderConnectionId.makeUnsafe("connection-b"), 67],
    ]);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never fetches usage for API-key Connections", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "penkra-connection-usage-"));
    createdRoots.push(stateDir);
    const fetchMock = vi.spyOn(outboundHttp, "request");
    const connections = [
      connection({
        id: "openai-key",
        harness: "codex",
        target: "openai-first-party",
        method: "api-key",
        profileRef: "provider-profile:openai-key",
      }),
      connection({
        id: "opencode-key",
        harness: "opencode",
        target: "opencode-zen",
        method: "api-key",
      }),
    ];

    const snapshots = await collectProviderConnectionUsageSnapshots({
      connections,
      stateDir,
      ctx: {
        homeDir: stateDir,
        env: {},
        platform: process.platform,
        nowMs: Date.parse(timestamp),
      },
    });

    expect(snapshots.map((snapshot) => snapshot.status)).toEqual(["unsupported", "unsupported"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not invoke macOS Keychain access for automatic Codex usage", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "penkra-connection-usage-"));
    createdRoots.push(stateDir);
    const snapshots = await collectProviderConnectionUsageSnapshots({
      connections: [
        connection({
          id: "codex-account",
          harness: "codex",
          target: "openai-first-party",
          method: "chatgpt",
          profileRef: "provider-profile:codex-account",
        }),
      ],
      stateDir,
      ctx: {
        homeDir: stateDir,
        env: {},
        platform: "darwin",
        nowMs: Date.parse(timestamp),
      },
    });

    expect(snapshots).toMatchObject([{ connectionId: "codex-account", status: "needs-auth" }]);
  });
});
