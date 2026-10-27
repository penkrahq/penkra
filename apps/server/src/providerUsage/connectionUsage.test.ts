import { ProviderConnectionId, type ServerProviderUsageSnapshot } from "@penkra/contracts";
import type { ProviderConnectionRecord } from "../persistence/Services/ProviderConnections.ts";
import { describe, expect, it, vi } from "vitest";
import { collectProviderConnectionUsageSnapshots } from "./index.ts";
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
    id: ProviderConnectionId.make(input.id),
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

const managed = (id: string) =>
  connection({
    id,
    harness: "claudeAgent",
    target: "anthropic-first-party",
    method: "claude-account",
    profileRef: "provider-profile:" + id,
  });
const snapshot = (usedPercent: number): ServerProviderUsageSnapshot => ({
  provider: "claudeAgent",
  updatedAt: timestamp,
  limits: [{ window: "5h", usedPercent }],
  usageLines: [],
  source: "provider-runtime",
  status: "ok",
});

describe("Connection-owned native usage", () => {
  it("reads each exact Connection independently", async () => {
    const readUsage = vi.fn(async (record: ProviderConnectionRecord) =>
      snapshot(record.id === "a" ? 12 : 67),
    );
    const result = await collectProviderConnectionUsageSnapshots({
      connections: [managed("a"), managed("b")],
      nowMs: Date.parse(timestamp),
      readUsage,
    });
    expect(result.map((value) => [value.connectionId, value.limits[0]?.usedPercent])).toEqual([
      ["a", 12],
      ["b", 67],
    ]);
    expect(readUsage.mock.calls.map(([record]) => record.profileRef)).toEqual([
      "provider-profile:a",
      "provider-profile:b",
    ]);
  });
  it("keeps a failed usage request local and does not invent an authentication failure", async () => {
    const result = await collectProviderConnectionUsageSnapshots({
      connections: [managed("a"), managed("b")],
      nowMs: Date.parse(timestamp),
      readUsage: async (record) => {
        if (record.id === "a") throw new Error("401; not logged in; reconnect");
        return snapshot(67);
      },
    });
    expect(result[0]).toMatchObject({
      connectionId: "a",
      status: "error",
      detail: "provider-error",
    });
    expect(result[1]).toMatchObject({
      connectionId: "b",
      status: "ok",
      limits: [{ usedPercent: 67 }],
    });
  });
  it("preserves a runtime-confirmed authentication result", async () => {
    const result = await collectProviderConnectionUsageSnapshots({
      connections: [managed("a")],
      nowMs: Date.parse(timestamp),
      readUsage: async () => ({ ...snapshot(0), status: "needs-auth" }),
    });
    expect(result[0]?.status).toBe("needs-auth");
  });
  it("does not invoke a usage runtime for static keys or OpenCode", async () => {
    const readUsage = vi.fn(async () => snapshot(99));
    const result = await collectProviderConnectionUsageSnapshots({
      connections: [
        connection({
          id: "key",
          harness: "codex",
          target: "openai-first-party",
          method: "api-key",
        }),
        connection({ id: "zen", harness: "opencode", target: "opencode-zen", method: "api-key" }),
      ],
      nowMs: Date.parse(timestamp),
      readUsage,
    });
    expect(readUsage).not.toHaveBeenCalled();
    expect(result.map((value) => value.status)).toEqual(["unsupported", "unsupported"]);
  });
  it("starts reads concurrently so one account cannot hold another account's result", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let secondStarted = false;
    const result = collectProviderConnectionUsageSnapshots({
      connections: [managed("a"), managed("b")],
      nowMs: Date.parse(timestamp),
      readUsage: async (record) => {
        if (record.id === "a") await held;
        else {
          secondStarted = true;
          release();
        }
        return snapshot(20);
      },
    });
    expect((await result).length).toBe(2);
    expect(secondStarted).toBe(true);
  });
});
