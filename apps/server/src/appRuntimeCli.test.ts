import { describe, expect, it, vi } from "vitest";

import { executePenkraExecCommand, parseOperationInput, parsePenkraCommand } from "./appRuntimeCli";
import { PENKRA_SERVER_MANUAL_MARKER } from "./agentGateway/harnessPolicy";

const context = { spaceId: "personal", threadId: "thread-1" };
const command = (...words: string[]) => ({ command: words.join(" ") });
const catalog = [
  {
    slug: "explorer",
    summary: "Open local resources.",
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
      documentId: { type: "string" },
    },
  } as const;

  it("maps schema-declared root command flags to typed App input", () => {
    expect(
      parseOperationInput(schema, undefined, {
        title: "Fix redirect",
        confirm: true,
        priority: 2,
        "document-id": "doc-1",
      }),
    ).toEqual({
      title: "Fix redirect",
      confirm: true,
      priority: 2,
      documentId: "doc-1",
    });
  });

  it("recovers a JSON object string once when the resolved schema expects an object", () => {
    expect(parseOperationInput(schema, '{"title":"Fix redirect","confirm":true}', {})).toEqual({
      title: "Fix redirect",
      confirm: true,
    });
    expect(parseOperationInput(schema, '"{\\"title\\":\\"nested\\"}"', {})).toBe(
      '"{\\"title\\":\\"nested\\"}"',
    );
    expect(parseOperationInput(schema, '["not","an","object"]', {})).toBe('["not","an","object"]');
    expect(
      parseOperationInput(
        { $ref: "#/$defs/input", $defs: { input: schema } },
        '{"title":"Resolved through a ref"}',
        {},
      ),
    ).toEqual({ title: "Resolved through a ref" });
  });

  it("rejects unknown, duplicate, and invalid typed flags", () => {
    expect(() => parseOperationInput(schema, undefined, { unknown: "value" })).toThrow(
      "Unknown operation option",
    );
    expect(() => parseOperationInput(schema, { title: "one" }, { title: "two" })).toThrow("both");
    expect(() => parseOperationInput(schema, undefined, { confirm: "yes" })).toThrow(
      "true or false",
    );
  });
});

describe("penkra_exec_command structure", () => {
  it("parses ordinary quoted command values without evaluating them", () => {
    expect(
      parsePenkraCommand(
        'canvas documents create --title \'Use $fog and `code`\' --input \'{"nested":{"quote":"hello"}}\'',
      ),
    ).toMatchObject({
      command: ["canvas", "documents", "create"],
      flags: { title: "Use $fog and `code`" },
      input: {
        nested: { quote: "hello" },
      },
    });
  });

  it("rejects duplicate options instead of silently choosing one", () => {
    expect(() => parsePenkraCommand("canvas documents create --title One --title Two")).toThrow(
      "only once",
    );
  });
});

describe("penkra_exec_command discovery", () => {
  it("documents every core discovery path and the enabled App roots", async () => {
    const bridge = async (method: string) => {
      expect(method).toBe("catalog.list");
      return catalog;
    };

    const help = await executePenkraExecCommand(command("penkra", "--help"), context, {}, bridge);
    expect(help).toContain(PENKRA_SERVER_MANUAL_MARKER);
    expect(help).toContain("`penkra apps list`");
    expect(help).toContain("### explorer");
    expect(help).toContain("Open local resources.");
    expect(help).toContain("`resources.open`");
  });

  it("discovers and scopes every App developer command", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const bridge = async (method: string, params: unknown) => {
      calls.push({ method, params });
      return method === "catalog.list" ? catalog : { status: "installed" };
    };
    const env = {};

    const help = await executePenkraExecCommand(command("penkra", "--help"), context, env, bridge);
    expect(help).toContain("penkra app test <directory>");
    expect(help).toContain("penkra app sideload <directory>");
    await expect(
      executePenkraExecCommand(
        command("penkra", "app", "sideload", "./dist"),
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

  it("exposes sideload in ordinary Penkra", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const bridge = async (method: string, params: unknown) => {
      calls.push({ method, params });
      return method === "catalog.list" ? catalog : { status: "installed" };
    };

    const help = await executePenkraExecCommand(command("penkra", "--help"), context, {}, bridge);
    expect(help).toContain("penkra app test <directory>");
    expect(help).toContain("penkra app sideload <directory>");
    await expect(
      executePenkraExecCommand(
        command("penkra", "app", "sideload", "./dist"),
        { ...context, workingDirectory: "/workspace" },
        {},
        bridge,
      ),
    ).resolves.toEqual({ status: "installed" });
    expect(calls.at(-1)).toEqual({
      method: "developer.sideload",
      params: { sourcePath: "/workspace/dist", spaceId: "personal" },
    });
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
        command("penkra", "app", "test", "./dist"),
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
        command("penkra", "app", "package", "./dist", "--output", "./build/app.penkra"),
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
        command("penkra", "app", "status", "--app-id", "app-1"),
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
      command("penkra", "app", "publish", "./dist", "--visibility", "public"),
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
      command(
        "penkra",
        "app",
        "access",
        "invite",
        "--app-id",
        "app-1",
        "--email",
        "person@example.com",
      ),
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
    for (const invalid of [
      command("penkra", "app", "test", "./dist", "--input", "{}"),
      command("penkra", "app", "package", "./dist", "--output", "./app.penkra", "--extra", "value"),
      command("penkra", "app", "publish", "./dist", "--visibility", "shared"),
    ]) {
      await expect(
        executePenkraExecCommand(invalid, developerContext, env, async () => []),
      ).rejects.toThrow();
    }
  });

  it("lists only the Apps and operation keys returned for the caller Space", async () => {
    const bridge = async (_method: string, params: unknown) => {
      expect(params).toEqual(context);
      return catalog;
    };

    await expect(
      executePenkraExecCommand(command("penkra", "apps", "list"), context, {}, bridge),
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

    await executePenkraExecCommand(command("penkra", "tabs", "list"), context, {}, bridge);
    await executePenkraExecCommand(
      command("penkra", "tabs", "snapshot", "--tab-id", "tab-A"),
      context,
      {},
      bridge,
    );
    await executePenkraExecCommand(
      command(
        "penkra",
        "tabs",
        "type",
        "--tab-id",
        "tab-A",
        "--target",
        "e7",
        "--text",
        "'Updated copy'",
      ),
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
        params: { ...context, tabId: "tab-A", target: "e7", text: "Updated copy" },
      },
    ]);
  });

  it("documents tab commands in the callable penkra_exec_command shape", async () => {
    const help = await executePenkraExecCommand(
      command("penkra", "tabs", "--help"),
      context,
      {},
      async () => [],
    );

    expect(help).toMatchObject({
      commands: expect.arrayContaining([
        "penkra tabs list",
        "penkra tabs snapshot --tab-id <id>",
        "penkra tabs screenshot",
      ]),
      examples: expect.arrayContaining([
        { command: "penkra tabs list" },
        { command: "penkra tabs screenshot" },
        { command: "penkra tabs click --tab-id <tab-id> --target e17 --observe true" },
      ]),
    });
  });

  it("parses scoped snapshots, observed actions, dialogs, and App-storage uploads", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const bridge = async (method: string, params: unknown) => {
      calls.push({ method, params });
      return {};
    };
    await executePenkraExecCommand(
      command(
        "penkra",
        "tabs",
        "snapshot",
        "--tab-id",
        "tab-A",
        "--target",
        "e3",
        "--depth",
        "2",
        "--boxes",
        "true",
      ),
      context,
      {},
      bridge,
    );
    await executePenkraExecCommand(
      command(
        "penkra",
        "tabs",
        "click",
        "--tab-id",
        "tab-A",
        "--target",
        "e1",
        "--observe",
        "true",
      ),
      context,
      {},
      bridge,
    );
    await executePenkraExecCommand(
      command("penkra", "tabs", "handle-dialog", "--tab-id", "tab-A", "--accept", "false"),
      context,
      {},
      bridge,
    );
    await executePenkraExecCommand(
      command(
        "penkra",
        "tabs",
        "upload",
        "--tab-id",
        "tab-A",
        "--target",
        "e2",
        "--input",
        '\'{"paths":["/app/report.pdf"]}\'',
      ),
      context,
      {},
      bridge,
    );
    expect(calls).toEqual([
      {
        method: "tabs.snapshot",
        params: { ...context, tabId: "tab-A", target: "e3", depth: 2, boxes: true },
      },
      {
        method: "tabs.click",
        params: { ...context, tabId: "tab-A", target: "e1", observe: true },
      },
      { method: "tabs.handle-dialog", params: { ...context, tabId: "tab-A", accept: false } },
      {
        method: "tabs.upload",
        params: { ...context, tabId: "tab-A", target: "e2", paths: ["/app/report.pdf"] },
      },
    ]);
  });

  it("resolves tab artifact filenames against the caller Thread directory", async () => {
    const bridge = vi.fn(async () => ({ filename: "/workspace/artifacts/canvas.md" }));
    await executePenkraExecCommand(
      command(
        "penkra",
        "tabs",
        "snapshot",
        "--tab-id",
        "tab-A",
        "--filename",
        "artifacts/canvas.md",
      ),
      { ...context, workingDirectory: "/workspace" },
      {},
      bridge,
    );

    expect(bridge).toHaveBeenCalledWith(
      "tabs.snapshot",
      {
        ...context,
        tabId: "tab-A",
        outputPath: "/workspace/artifacts/canvas.md",
      },
      {},
    );
  });

  it("points unknown core commands back to the canonical help command", async () => {
    await expect(
      executePenkraExecCommand(command("penkra", "app", "unknown"), context, {}, async () => []),
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
      executePenkraExecCommand({ command: `penkra open --path ${path}` }, context, {}, bridge),
    ).resolves.toEqual({ destination: "app", slug: "explorer", path });
  });
});
