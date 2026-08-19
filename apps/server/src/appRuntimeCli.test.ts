import { describe, expect, it, vi } from "vitest";

import {
  executePenkraExecCommand,
  parseOperationInput,
  tokenizeRegisteredCommand,
} from "./appRuntimeCli";

const context = { spaceId: "personal", threadId: "thread-1" };
const catalog = [
  {
    slug: "explorer",
    operations: [{ key: "resources.open", input: { type: "object", properties: {} } }],
  },
];

describe("App runtime CLI operation flags", () => {
  const schema = {
    type: "object",
    properties: {
      title: { type: "string" },
      confirm: { type: "boolean" },
      priority: { type: "integer" },
      labels: { type: "array" },
    },
  } as const;

  it("maps schema-declared root command flags to typed App input", () => {
    expect(
      parseOperationInput(schema, undefined, {
        title: "Fix redirect",
        confirm: "true",
        priority: "2",
        labels: '["auth"]',
      }),
    ).toEqual({
      title: "Fix redirect",
      confirm: true,
      priority: 2,
      labels: ["auth"],
    });
  });

  it("rejects unknown, duplicate, and invalid typed flags", () => {
    expect(() => parseOperationInput(schema, undefined, { unknown: "value" })).toThrow(
      "Unknown operation option",
    );
    expect(() => parseOperationInput(schema, '{"title":"one"}', { title: "two" })).toThrow("both");
    expect(() => parseOperationInput(schema, undefined, { confirm: "yes" })).toThrow(
      "true or false",
    );
  });
});

describe("penkra_exec_command tokenization", () => {
  it("preserves quoted structured input without invoking a shell", () => {
    expect(
      tokenizeRegisteredCommand(
        `linear issues create --title "Fix redirect" --input '{"priority":2}'`,
      ),
    ).toEqual([
      "linear",
      "issues",
      "create",
      "--title",
      "Fix redirect",
      "--input",
      '{"priority":2}',
    ]);
  });

  it("rejects shell syntax and expansion", () => {
    for (const command of [
      "ffmpeg encode | cat",
      "linear issues list > out",
      "echo $HOME",
      "x $(y)",
    ]) {
      expect(() => tokenizeRegisteredCommand(command)).toThrow();
    }
  });

  it("does not confuse a native executable name with an App root", () => {
    expect(tokenizeRegisteredCommand("ffmpeg media encode --input '{}'")[0]).toBe("ffmpeg");
    expect(tokenizeRegisteredCommand("penkra tabs current")[0]).toBe("penkra");
  });
});

describe("penkra_exec_command discovery", () => {
  it("documents every core discovery path and the enabled App roots", async () => {
    const bridge = async (method: string) => {
      expect(method).toBe("catalog.list");
      return catalog;
    };

    await expect(
      executePenkraExecCommand("penkra --help", context, {}, bridge),
    ).resolves.toMatchObject({
      commands: expect.arrayContaining(["penkra apps list", "penkra tabs current"]),
      appCommands: [
        {
          root: "explorer",
          help: "penkra_exec_command: explorer --help",
          operations: ["resources.open"],
        },
      ],
    });
  });

  it("discovers and scopes every App developer command in development", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const bridge = async (method: string, params: unknown) => {
      calls.push({ method, params });
      return method === "catalog.list" ? catalog : { status: "installed" };
    };
    const env = { PENKRA_DESKTOP_FLAVOR: "development" };

    await expect(
      executePenkraExecCommand("penkra --help", context, env, bridge),
    ).resolves.toMatchObject({
      commands: expect.arrayContaining([
        "penkra app test <directory>",
        "penkra app package <directory> --output <path>",
        "penkra app sideload <directory>",
        "penkra app status [--app-id <app-id>]",
        "penkra app publish <directory> [--visibility public|private]",
        "penkra app access invite --app-id <app-id> --email <email>",
      ]),
    });
    await expect(
      executePenkraExecCommand(
        "penkra app sideload ./dist",
        { ...context, workingDirectory: "/workspace" },
        env,
        bridge,
      ),
    ).resolves.toEqual({ status: "installed" });
    expect(calls.at(-1)).toEqual({
      method: "developer.sideload",
      params: { sourcePath: "/workspace/dist", spaceId: "personal" },
    });
  });

  it("exposes public App-author commands in ordinary Penkra but keeps sideload internal", async () => {
    const bridge = async (method: string) => {
      expect(method).toBe("catalog.list");
      return catalog;
    };

    await expect(
      executePenkraExecCommand("penkra --help", context, {}, bridge),
    ).resolves.toMatchObject({
      commands: expect.arrayContaining([
        "penkra app test <directory>",
        "penkra app publish <directory> [--visibility public|private]",
      ]),
    });
    await expect(
      executePenkraExecCommand("penkra --help", context, {}, bridge),
    ).resolves.toMatchObject({
      commands: expect.not.arrayContaining(["penkra app sideload <directory>"]),
    });
    await expect(
      executePenkraExecCommand("penkra app sideload ./dist", context, {}, bridge),
    ).rejects.toThrow("internal Penkra development command");
  });

  it("routes test, package, status, publish, and access without consulting PATH", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const bridge = vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      return { ok: true };
    });
    const publish = vi.fn(async (input: unknown) => ({
      operation: "publish",
      input,
    }));
    const operations = {
      test: vi.fn(async (input: unknown) => ({ operation: "test", input })),
      package: vi.fn(async (input: unknown) => ({
        operation: "package",
        input,
      })),
      status: vi.fn(async (appId: string | undefined) => ({
        operation: "status",
        appId,
      })),
      publish,
    } as unknown as NonNullable<Parameters<typeof executePenkraExecCommand>[4]>;
    const developmentContext = { ...context, workingDirectory: "/workspace" };
    const env = {
      PENKRA_DESKTOP_FLAVOR: "development",
      PENKRA_API_URL: "http://localhost:3012",
    };

    await expect(
      executePenkraExecCommand(
        "penkra app test ./dist",
        developmentContext,
        env,
        bridge,
        operations,
      ),
    ).resolves.toEqual({
      operation: "test",
      input: { directory: "/workspace/dist" },
    });
    await expect(
      executePenkraExecCommand(
        "penkra app package ./dist --output ./build/app.penkra",
        developmentContext,
        env,
        bridge,
        operations,
      ),
    ).resolves.toEqual({
      operation: "package",
      input: {
        directory: "/workspace/dist",
        output: "/workspace/build/app.penkra",
      },
    });
    await expect(
      executePenkraExecCommand(
        "penkra app status --app-id app-1",
        developmentContext,
        env,
        bridge,
        operations,
      ),
    ).resolves.toEqual({
      registryTarget: {
        environment: "local",
        apiOrigin: "http://localhost:3012",
      },
      operation: "status",
      appId: "app-1",
    });
    await executePenkraExecCommand(
      "penkra app publish ./dist --visibility public",
      developmentContext,
      env,
      bridge,
      operations,
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: "/workspace/dist",
        visibility: "public",
        env,
      }),
    );
    await executePenkraExecCommand(
      "penkra app access invite --app-id app-1 --email person@example.com",
      developmentContext,
      env,
      bridge,
      operations,
    );
    expect(calls.at(-1)).toEqual({
      method: "developer.app-access.invite",
      params: { appId: "app-1", email: "person@example.com" },
    });
  });

  it("rejects developer-only meta flags, unknown options, and invalid visibility", async () => {
    const env = { PENKRA_DESKTOP_FLAVOR: "development" };
    const developerContext = { ...context, workingDirectory: "/workspace" };
    for (const command of [
      "penkra app test ./dist --schema",
      "penkra app package ./dist --output ./app.penkra --extra value",
      "penkra app publish ./dist --visibility shared",
    ]) {
      await expect(
        executePenkraExecCommand(command, developerContext, env, async () => []),
      ).rejects.toThrow();
    }
  });

  it("lists only the Apps and operation keys returned for the caller Space", async () => {
    const bridge = async (_method: string, params: unknown) => {
      expect(params).toEqual(context);
      return catalog;
    };

    await expect(
      executePenkraExecCommand("penkra apps list", context, {}, bridge),
    ).resolves.toEqual({
      spaceId: "personal",
      apps: [{ slug: "explorer", operations: ["resources.open"] }],
    });
  });

  it("scopes tab discovery and observation to the caller Thread and Space", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const bridge = async (method: string, params: unknown) => {
      calls.push({ method, params });
      return { ok: true };
    };

    await executePenkraExecCommand("penkra tabs list", context, {}, bridge);
    await executePenkraExecCommand("penkra tabs snapshot --tab-id tab-A", context, {}, bridge);
    await executePenkraExecCommand(
      'penkra tabs type --tab-id tab-A --ref a7 --text "Updated copy"',
      context,
      {},
      bridge,
    );

    expect(calls).toEqual([
      { method: "tabs.list", params: context },
      {
        method: "tabs.snapshot",
        params: { ...context, tabId: "tab-A" },
      },
      {
        method: "tabs.type",
        params: { ...context, tabId: "tab-A", ref: "a7", text: "Updated copy" },
      },
    ]);
  });

  it("parses expanded snapshots, observed actions, dialogs, and App-storage uploads", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const bridge = async (method: string, params: unknown) => {
      calls.push({ method, params });
      return {};
    };
    await executePenkraExecCommand(
      "penkra tabs snapshot --tab-id tab-A --expand true",
      context,
      {},
      bridge,
    );
    await executePenkraExecCommand(
      "penkra tabs click --tab-id tab-A --ref a1 --observe true",
      context,
      {},
      bridge,
    );
    await executePenkraExecCommand(
      "penkra tabs handle-dialog --tab-id tab-A --accept false",
      context,
      {},
      bridge,
    );
    await executePenkraExecCommand(
      "penkra tabs upload --tab-id tab-A --ref a2 --paths '[\"/app/report.pdf\"]'",
      context,
      {},
      bridge,
    );
    expect(calls).toEqual([
      { method: "tabs.snapshot", params: { ...context, tabId: "tab-A", expand: true } },
      { method: "tabs.click", params: { ...context, tabId: "tab-A", ref: "a1", observe: true } },
      { method: "tabs.handle-dialog", params: { ...context, tabId: "tab-A", accept: false } },
      {
        method: "tabs.upload",
        params: { ...context, tabId: "tab-A", ref: "a2", paths: ["/app/report.pdf"] },
      },
    ]);
  });

  it("points unknown core commands back to the canonical help command", async () => {
    await expect(
      executePenkraExecCommand("penkra app unknown", context, {}, async () => []),
    ).rejects.toThrow("Run penkra app --help");
  });

  it("returns the canonical path reported by the desktop when opening a file", async () => {
    const path = "/workspace/penkra-apps/canvas/DESIGN_SPEC.md";
    const bridge = async (method: string, params: unknown) => {
      expect(method).toBe("core.open");
      expect(params).toEqual({ ...context, path });
      return { destination: "app", slug: "explorer", path };
    };

    await expect(
      executePenkraExecCommand(`penkra open --path ${path}`, context, {}, bridge),
    ).resolves.toEqual({ destination: "app", slug: "explorer", path });
  });
});
