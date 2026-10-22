import { describe, expect, it, vi } from "vitest";
import { CodexAppServerManager } from "./codexAppServerManager.ts";
import type { ProviderManagedLaunchContext } from "./provider/Services/ProviderAdapter.ts";
import { CodexResponseTooLargeError } from "./codexAppServerTransport.ts";

const launch: ProviderManagedLaunchContext = {
  binaryPath: "/managed/codex",
  isolationKey: "account-a",
  profileRoot: "/profile",
  nativeStateRoot: "/native",
  childEnvironment: () => ({}),
};

function setup() {
  const manager = new CodexAppServerManager();
  const internals = manager as unknown as {
    getOrCreateManagedProcess(cwd: string, launch: ProviderManagedLaunchContext): Promise<unknown>;
    sendRequest(
      transport: unknown,
      threadId: null,
      method: string,
      params: unknown,
    ): Promise<unknown>;
    stopAll(): Promise<void>;
  };
  const transport = {};
  const account = vi.spyOn(internals, "getOrCreateManagedProcess").mockResolvedValue(transport);
  const request = vi.spyOn(internals, "sendRequest").mockResolvedValue({});
  return { manager, transport, account, request };
}

describe("Codex account catalog", () => {
  it("routes native catalog invalidations to account Connections even without an active thread", () => {
    const manager = new CodexAppServerManager();
    const internals = manager as unknown as {
      handleStdoutLine(transport: unknown, line: string): void;
    };
    const events: unknown[] = [];
    manager.on("catalogInvalidated", (event) => events.push(event));
    const transport = { connectionIds: new Set(["account-a", "account-b"]), threads: new Set() };
    internals.handleStdoutLine(transport, JSON.stringify({ method: "skills/changed", params: {} }));
    internals.handleStdoutLine(
      transport,
      JSON.stringify({ method: "account/updated", params: {} }),
    );
    expect(events).toEqual([
      { connectionId: "account-a", kinds: ["skills"] },
      { connectionId: "account-b", kinds: ["skills"] },
      { connectionId: "account-a", kinds: ["models"] },
      { connectionId: "account-b", kinds: ["models"] },
    ]);
    expect(manager.listSessions()).toEqual([]);
  });

  it("uses installed plugins and scoped skills without an active thread", async () => {
    const { manager, account, request, transport } = setup();
    request.mockImplementation(async (_transport, _thread, method) =>
      method === "skills/list"
        ? { data: [{ cwd: "/repo", skills: [{ name: "review", path: "/repo/SKILL.md" }] }] }
        : {
            marketplaces: [
              {
                name: "local",
                path: "/marketplace",
                plugins: [
                  {
                    id: "installed",
                    name: "installed",
                    source: { path: "/installed" },
                    installed: true,
                    enabled: true,
                    installPolicy: "AVAILABLE",
                    authPolicy: "ON_USE",
                  },
                  {
                    id: "suggestion",
                    name: "suggestion",
                    source: { path: "/suggestion" },
                    installed: false,
                    enabled: false,
                    installPolicy: "AVAILABLE",
                    authPolicy: "ON_INSTALL",
                  },
                ],
              },
            ],
            marketplaceLoadErrors: [],
          },
    );
    const result = await manager.loadCatalog({
      cwd: "/repo",
      managedLaunch: launch,
      kinds: ["skills", "plugins", "agents", "commands"],
    });
    expect(account).toHaveBeenCalledExactlyOnceWith("/repo", launch);
    expect(request).toHaveBeenCalledWith(transport, null, "skills/list", { cwds: ["/repo"] });
    expect(request).toHaveBeenCalledWith(transport, null, "plugin/installed", { cwds: ["/repo"] });
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.skills).toEqual([{ name: "review", path: "/repo/SKILL.md", enabled: true }]);
    expect(result.plugins?.[0]?.plugins.map((plugin) => plugin.name)).toEqual(["installed"]);
    expect(result).not.toHaveProperty("agents");
    expect(result).not.toHaveProperty("commands");
    expect(manager.listSessions()).toEqual([]);
  });

  it("does not start an account process for unsupported kinds", async () => {
    const { manager, account } = setup();
    expect(
      await manager.loadCatalog({
        cwd: "/repo",
        managedLaunch: launch,
        kinds: ["agents", "commands"],
      }),
    ).toEqual({});
    expect(account).not.toHaveBeenCalled();
  });

  it("reads every model page instead of silently keeping the first page", async () => {
    const { manager, request } = setup();
    request
      .mockResolvedValueOnce({ data: [{ id: "first", name: "First" }], nextCursor: "next" })
      .mockResolvedValueOnce({ data: [{ id: "second", name: "Second" }], nextCursor: null });
    const result = await manager.loadCatalog({
      cwd: "/repo",
      managedLaunch: launch,
      kinds: ["models"],
    });
    expect(result.models?.map((model) => model.slug)).toEqual(["first", "second"]);
    expect(request.mock.calls.map((call) => call[3])).toEqual([
      { cursor: null, includeHidden: false },
      { cursor: "next", includeHidden: false },
    ]);
  });

  it("fails a repeated cursor rather than returning a partial catalog or looping", async () => {
    const { manager, request } = setup();
    request.mockResolvedValue({ data: [], nextCursor: "same" });
    await expect(
      manager.loadCatalog({ cwd: "/repo", managedLaunch: launch, kinds: ["models"] }),
    ).rejects.toThrow("repeated a pagination cursor");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("returns marketplace load failures rather than a misleading empty success", async () => {
    const { manager, request } = setup();
    request.mockResolvedValue({
      marketplaces: [],
      marketplaceLoadErrors: [{ marketplacePath: "/bad", message: "invalid manifest" }],
    });
    await expect(
      manager.loadCatalog({ cwd: "/repo", managedLaunch: launch, kinds: ["plugins"] }),
    ).rejects.toThrow("invalid manifest");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("propagates an oversized or method-not-found failure once, without compatibility requests", async () => {
    for (const error of [
      new CodexResponseTooLargeError("plugin/installed", 1, 18_000_000),
      Object.assign(new Error("method not found"), { code: -32601 }),
    ]) {
      const { manager, request } = setup();
      request.mockRejectedValue(error);
      await expect(
        manager.loadCatalog({ cwd: "/repo", managedLaunch: launch, kinds: ["plugins"] }),
      ).rejects.toBe(error);
      expect(request).toHaveBeenCalledTimes(1);
      expect(manager.listSessions()).toEqual([]);
    }
  });
});
