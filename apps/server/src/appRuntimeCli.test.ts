import { describe, expect, it, vi } from "vitest";

import {
  executePenkraExecCommand,
  parseOperationInput,
  structuredArguments,
} from "./appRuntimeCli";

const context = { spaceId: "personal", threadId: "thread-1" };
const command = (...words: string[]) => ({ command: words });
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
  it("keeps literal values out of command parsing", () => {
    expect(
      structuredArguments([], {
        input: {
          variable: "$fog",
          prose: "Use `code` and a newline\nhere",
          nested: { quote: 'He said "hello".' },
        },
      }),
    ).toMatchObject({
      positionals: [],
      input: {
        variable: "$fog",
        prose: "Use `code` and a newline\nhere",
        nested: { quote: 'He said "hello".' },
      },
    });
  });

  it("requires options to use the structured fields", () => {
    expect(() => structuredArguments(["--title", "Fix"], {})).toThrow("belong in flags");
  });
});

describe("penkra_exec_command discovery", () => {
  it("documents every core discovery path and the enabled App roots", async () => {
    const bridge = async (method: string) => {
      expect(method).toBe("catalog.list");
      return catalog;
    };

    const help = await executePenkraExecCommand(command("penkra", "--help"), context, {}, bridge);
    expect(help).toContain("# Penkra");
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
    expect(help).toContain('"penkra", "app", "test"');
    expect(help).toContain('"penkra", "app", "sideload"');
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
    expect(help).toContain('"penkra", "app", "test"');
    expect(help).toContain('"penkra", "app", "sideload"');
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
        {
          command: ["penkra", "app", "package", "./dist"],
          flags: { output: "./build/app.penkra" },
        },
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
        { command: ["penkra", "app", "status"], flags: { "app-id": "app-1" } },
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
      {
        command: ["penkra", "app", "publish", "./dist"],
        flags: { visibility: "public" },
      },
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
      {
        command: ["penkra", "app", "access", "invite"],
        flags: { "app-id": "app-1", email: "person@example.com" },
      },
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
      { command: ["penkra", "app", "test", "./dist"], input: {} },
      {
        command: ["penkra", "app", "package", "./dist"],
        flags: { output: "./app.penkra", extra: "value" },
      },
      {
        command: ["penkra", "app", "publish", "./dist"],
        flags: { visibility: "shared" },
      },
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
      { command: ["penkra", "tabs", "snapshot"], tabId: "tab-A" },
      context,
      {},
      bridge,
    );
    await executePenkraExecCommand(
      {
        command: ["penkra", "tabs", "type"],
        tabId: "tab-A",
        flags: { ref: "a7", text: "Updated copy" },
      },
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
      {
        command: ["penkra", "tabs", "snapshot"],
        tabId: "tab-A",
        flags: { expand: true },
      },
      context,
      {},
      bridge,
    );
    await executePenkraExecCommand(
      {
        command: ["penkra", "tabs", "click"],
        tabId: "tab-A",
        flags: { ref: "a1", observe: true },
      },
      context,
      {},
      bridge,
    );
    await executePenkraExecCommand(
      {
        command: ["penkra", "tabs", "handle-dialog"],
        tabId: "tab-A",
        flags: { accept: false },
      },
      context,
      {},
      bridge,
    );
    await executePenkraExecCommand(
      {
        command: ["penkra", "tabs", "upload"],
        tabId: "tab-A",
        flags: { ref: "a2" },
        input: { paths: ["/app/report.pdf"] },
      },
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
      executePenkraExecCommand(
        { command: ["penkra", "open"], flags: { path } },
        context,
        {},
        bridge,
      ),
    ).resolves.toEqual({ destination: "app", slug: "explorer", path });
  });
});
