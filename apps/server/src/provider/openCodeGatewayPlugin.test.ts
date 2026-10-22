import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { MODEL_SELECTION_INPUT_SCHEMA } from "../agentGateway/toolInput.ts";
import { PENKRA_EXEC_COMMAND_INPUT_SCHEMA } from "../agentGateway/hostToolContract.ts";
import {
  ensureOpenCodeGatewayPlugin,
  openCodeGatewayPluginSource,
  openCodeSchemaExpression,
} from "./openCodeGatewayPlugin.ts";

const compile = (schema: Record<string, unknown>): z.ZodType =>
  new Function("s", `return ${openCodeSchemaExpression(schema)}`)(z);

describe("OpenCode canonical gateway declarations", () => {
  it("atomically installs one declaration file under concurrent preparations", async () => {
    const scratch = path.resolve(
      import.meta.dirname,
      "../../../..",
      ".penkra/scratch/opencode-gateway-plugin",
    );
    await mkdir(scratch, { recursive: true });
    const profile = await mkdtemp(path.join(scratch, "profile-"));
    try {
      const definitions = [
        { name: "test", description: "Test", inputSchema: { type: "object", properties: {} } },
      ];
      const files = await Promise.all([
        ensureOpenCodeGatewayPlugin(profile, definitions),
        ensureOpenCodeGatewayPlugin(profile, definitions),
      ]);
      expect(files[0]).toBe(files[1]);
      expect(await readFile(files[0]!, "utf8")).toBe(openCodeGatewayPluginSource(definitions));
      expect(await readdir(path.dirname(files[0]!))).toEqual(["penkra-gateway.js"]);
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });
  it("preserves canonical model selection and command fields without a second schema", () => {
    const selection = compile(MODEL_SELECTION_INPUT_SCHEMA);
    expect(
      selection.parse({ provider: "codex", model: "example", options: { effort: "high" } }),
    ).toEqual({ provider: "codex", model: "example", options: { effort: "high" } });
    expect(selection.safeParse({ provider: "other", model: "example" }).success).toBe(false);
    expect(selection.safeParse({ provider: "codex" }).success).toBe(false);
    const command = compile(PENKRA_EXEC_COMMAND_INPUT_SCHEMA);
    expect(command.parse({ command: "penkra --help" })).toEqual({ command: "penkra --help" });
    expect(command.safeParse({ command: "" }).success).toBe(false);
  });

  it("retains nullable, optional, array and length constraints and rejects unsupported schema evolution", () => {
    const schema = compile({
      type: "object",
      properties: {
        connectionId: { type: ["string", "null"] },
        paths: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
      },
      required: ["paths"],
      additionalProperties: false,
    });
    expect(schema.parse({ connectionId: null, paths: ["/tmp/image.png"] })).toEqual({
      connectionId: null,
      paths: ["/tmp/image.png"],
    });
    expect(schema.safeParse({ paths: [] }).success).toBe(false);
    expect(schema.safeParse({ paths: [""] }).success).toBe(false);
    expect(schema.safeParse({ paths: ["x"], unexpected: true }).success).toBe(false);
    expect(() => openCodeSchemaExpression({ type: "string", pattern: "x" })).toThrow(
      "Unsupported native gateway schema keyword",
    );
  });

  it("uses native context attribution and preserves text, images, resources and tool errors", async () => {
    const source = openCodeGatewayPluginSource([
      {
        name: "test",
        description: "Test",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ]);
    const requests: RequestInit[] = [];
    let result: Record<string, unknown> = {
      content: [
        { type: "text", text: "result" },
        { type: "image", mimeType: "image/png", data: "YWJj" },
        {
          type: "resource",
          resource: {
            name: "file.bin",
            mimeType: "application/octet-stream",
            blob: "ZGVm",
            uri: "file:///ignored",
          },
        },
      ],
    };
    const create = new Function(
      "tool",
      "randomUUID",
      "fetch",
      "process",
      source
        .replace("import {tool} from '@opencode-ai/plugin';", "")
        .replace("import {randomUUID} from 'node:crypto';", "")
        .replace("export const PenkraGateway=", "const PenkraGateway=") + "\nreturn PenkraGateway;",
    );
    const plugin = await create(
      { schema: z },
      () => "request-1",
      async (_url: string, init: RequestInit) => {
        requests.push(init);
        return { ok: true, json: async () => ({ result }) };
      },
      {
        env: {
          PENKRA_GATEWAY_URL: "http://gateway/mcp",
          PENKRA_GATEWAY_PROCESS_TOKEN: "process-token",
        },
      },
    )();
    const context = { sessionID: "trusted-native-session", abort: new AbortController().signal };
    const output = await plugin.tool.test.execute({ sessionID: "forged" }, context);
    expect(requests[0]?.headers).toMatchObject({
      Authorization: "Bearer process-token",
      "x-penkra-native-session-id": "trusted-native-session",
    });
    expect(JSON.parse(String(requests[0]?.body)).id).toBe("request-1");
    expect(output.output).toBe("result");
    expect(output.attachments).toHaveLength(2);
    expect(output.attachments[0].url).toBe("data:image/png;base64,YWJj");
    expect(output.attachments[1].filename).toBe("file.bin");
    result = { isError: true, content: [{ type: "text", text: "exact gateway error" }] };
    await expect(plugin.tool.test.execute({}, context)).rejects.toThrow("exact gateway error");
  });
});
