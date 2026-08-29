import { describe, expect, it, vi } from "vitest";

import {
  executePenkraExecCommand,
  formatRuntimeFailure,
  parseOperationInput,
  parsePenkraCommand,
} from "./appRuntimeCli";
import { PENKRA_SERVER_MANUAL_MARKER } from "./agentGateway/harnessPolicy";

const context = { spaceId: "personal", threadId: "thread-1" };
const command = (...words: string[]) => ({ command: words.join(" ") });
const catalog = [
  {
    slug: "apps",
    summary: "Manage Apps.",
    operations: [{ key: "list", input: { type: "object", properties: {} } }],
  },
  {
    slug: "explorer",
    summary: "Open local resources.",
    operations: [{ key: "resources.open", input: { type: "object", properties: {} } }],
  },
];

describe("App runtime CLI failures", () => {
  it("renders primary and labelled cleanup branches without parsing message text", () => {
    expect(
      formatRuntimeFailure({
        kind: "operation",
        message: "App update failed.",
        primary: { kind: "leaf", code: "ACTIVATION_FAILED", message: "Activation failed." },
        secondary: [
          {
            role: "restore-state",
            failure: { kind: "leaf", message: "State restore failed." },
          },
        ],
      }),
    ).toBe(
      [
        "App update failed.",
        "Primary:",
        "  Activation failed.",
        "restore-state:",
        "  State restore failed.",
      ].join("\n"),
    );
  });
});

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
    expect(() => parseOperationInput(schema, '"{\\"title\\":\\"nested\\"}"', {})).toThrow(
      "declared schema",
    );
    expect(() => parseOperationInput(schema, '["not","an","object"]', {})).toThrow(
      "declared schema",
    );
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

  it("enforces required fields and schema constraints after decoding flags", () => {
    const constrained = {
      type: "object",
      properties: {
        ref: { type: "string", pattern: "^e[0-9]+$" },
        visibility: { type: "string", enum: ["private", "public"] },
      },
      required: ["ref"],
      additionalProperties: false,
    } as const;
    expect(() => parseOperationInput(constrained, undefined, {})).toThrow("required property");
    expect(() => parseOperationInput(constrained, undefined, { ref: "button" })).toThrow("pattern");
    expect(() =>
      parseOperationInput(constrained, undefined, { ref: "e7", visibility: "shared" }),
    ).toThrow("allowed values");
    expect(
      parseOperationInput(constrained, undefined, { ref: "e7", visibility: "private" }),
    ).toEqual({ ref: "e7", visibility: "private" });
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

  it("reports exact App publication validator findings through the status command", async () => {
    const bridge = vi.fn(async (method: string) => {
      if (method === "developer.publishers.list") return [{ id: "publisher-1" }];
      if (method === "developer.apps.list") {
        return [{ id: "registry-app-1", identifier: "com.penkra.apps" }];
      }
      if (method === "developer.submissions.list") {
        return [
          {
            submissionId: "submission-1",
            version: "0.2.6",
            status: "validation-failed",
          },
        ];
      }
      if (method === "developer.submissions.get") {
        return {
          submissionId: "submission-1",
          version: "0.2.6",
          status: "validation-failed",
          validations: [
            {
              validator: "manifest",
              status: "failed",
              findings: [
                {
                  code: "invalid-manifest",
                  message: 'Unrecognized key: "instructions"',
                  path: "operations.0",
                },
              ],
            },
            {
              validator: "identity",
              status: "failed",
              findings: [
                {
                  code: "dependency-failed",
                  message: "Validation could not run because manifest is invalid.",
                },
              ],
            },
          ],
        };
      }
      throw new Error(`Unexpected bridge method ${method}`);
    });

    await expect(
      executePenkraExecCommand(
        command("penkra", "app", "status", "--app-id", "com.penkra.apps"),
        context,
        {},
        bridge,
      ),
    ).resolves.toMatchObject({
      submissions: [
        {
          validations: [
            {
              validator: "manifest",
              findings: [
                {
                  code: "invalid-manifest",
                  message: 'Unrecognized key: "instructions"',
                  path: "operations.0",
                },
              ],
            },
            {
              validator: "identity",
              findings: [
                {
                  code: "dependency-failed",
                  message: "Validation could not run because manifest is invalid.",
                },
              ],
            },
          ],
        },
      ],
    });
  });
});

describe("penkra_exec_command discovery", () => {
  it("documents Penkra operations without injecting the Space's App catalog", async () => {
    const bridge = vi.fn(async () => catalog);

    const help = await executePenkraExecCommand(command("penkra", "--help"), context, {}, bridge);
    expect(help).toContain(PENKRA_SERVER_MANUAL_MARKER);
    expect(help).toContain("`penkra tabs snapshot`");
    expect(help).not.toContain("### explorer");
    expect(bridge).not.toHaveBeenCalled();
  });

  it("discovers and scopes every App developer command", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const bridge = async (method: string, params: unknown) => {
      calls.push({ method, params });
      return method === "catalog.list" ? catalog : { status: "installed" };
    };
    const env = {};

    const help = await executePenkraExecCommand(command("penkra", "--help"), context, env, bridge);
    expect(help).toContain("penkra app test");
    expect(help).toContain("penkra app sideload");
    await expect(
      executePenkraExecCommand(
        command("penkra", "app", "sideload", "--directory", "./dist"),
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
    expect(help).toContain("penkra app test");
    expect(help).toContain("penkra app sideload");
    await expect(
      executePenkraExecCommand(
        command("penkra", "app", "sideload", "--directory", "./dist"),
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
        command("penkra", "app", "test", "--directory", "./dist"),
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
        command(
          "penkra",
          "app",
          "package",
          "--directory",
          "./dist",
          "--output",
          "./build/app.penkra",
        ),
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
      command("penkra", "app", "publish", "--directory", "./dist", "--visibility", "public"),
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
      command(
        "penkra",
        "app",
        "test",
        "--directory",
        "./dist",
        "--input",
        '{"directory":"./other"}',
      ),
      command(
        "penkra",
        "app",
        "package",
        "--directory",
        "./dist",
        "--output",
        "./app.penkra",
        "--extra",
        "value",
      ),
      command("penkra", "app", "publish", "--directory", "./dist", "--visibility", "shared"),
    ]) {
      await expect(
        executePenkraExecCommand(invalid, developerContext, env, async () => []),
      ).rejects.toThrow();
    }
  });

  it("routes App discovery through the Apps App without a Penkra-owned alias", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const bridge = async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "catalog.list") return catalog;
      return { apps: [{ slug: "explorer" }], pageInfo: { nextCursor: null } };
    };

    await expect(
      executePenkraExecCommand(command("apps", "list"), context, {}, bridge),
    ).resolves.toEqual({
      app: "apps",
      operation: "list",
      tabId: null,
      result: { apps: [{ slug: "explorer" }], pageInfo: { nextCursor: null } },
    });
    expect(calls).toEqual([
      { method: "catalog.list", params: context },
      {
        method: "operations.invoke",
        params: { app: "apps", operation: "list", input: {}, ...context },
      },
    ]);
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
        "--ref",
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

    expect(help).toContain("# Penkra tabs");
    expect(help).toContain("`penkra tabs list`");
    expect(help).toContain("`penkra tabs snapshot`");
    expect(help).toContain("`penkra tabs screenshot`");

    const clickHelp = await executePenkraExecCommand(
      command("penkra", "tabs", "click", "--help"),
      context,
      {},
      async () => [],
    );
    expect(clickHelp).toContain("Instructions");
    expect(clickHelp).toContain("penkra tabs click --tab-id <tab-id> --ref e17");
    expect(clickHelp).toContain('"ref"');
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
        "--ref",
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
      command("penkra", "tabs", "click", "--tab-id", "tab-A", "--ref", "e1", "--observe", "true"),
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
        "--ref",
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
