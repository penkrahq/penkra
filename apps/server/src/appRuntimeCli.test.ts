import { describe, expect, it } from "vitest";

import { executePenkraExec, parseOperationInput, tokenizeRegisteredCommand } from "./appRuntimeCli";

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
    ).toEqual({ title: "Fix redirect", confirm: true, priority: 2, labels: ["auth"] });
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

describe("penkra_exec command tokenization", () => {
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

describe("penkra_exec command discovery", () => {
  it("documents every core discovery path and the enabled App roots", async () => {
    const bridge = async (method: string) => {
      expect(method).toBe("catalog.list");
      return catalog;
    };

    await expect(executePenkraExec("penkra --help", context, {}, bridge)).resolves.toMatchObject({
      commands: expect.arrayContaining(["penkra apps list", "penkra tabs current"]),
      appCommands: [
        { root: "explorer", help: "penkra_exec: explorer --help", operations: ["resources.open"] },
      ],
    });
  });

  it("lists only the Apps and operation keys returned for the caller Space", async () => {
    const bridge = async (_method: string, params: unknown) => {
      expect(params).toEqual(context);
      return catalog;
    };

    await expect(executePenkraExec("penkra apps list", context, {}, bridge)).resolves.toEqual({
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

    await executePenkraExec("penkra tabs list", context, {}, bridge);
    await executePenkraExec("penkra tabs snapshot --tab-id tab-A", context, {}, bridge);
    await executePenkraExec(
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

  it("points unknown core commands back to the canonical help command", async () => {
    await expect(executePenkraExec("penkra app list", context, {}, async () => [])).rejects.toThrow(
      "Run penkra --help",
    );
  });
});
