import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  PENKRA_EXEC_COMMAND_INPUT_SCHEMA,
  PENKRA_EXEC_COMMAND_NAME,
  PENKRA_EXEC_COMMAND_DESCRIPTION,
} from "../agentGateway/hostToolContract.ts";
import {
  ensureOpenCodeGatewayPlugin,
  openCodeGatewayPluginSource,
} from "./openCodeGatewayPlugin.ts";

const definitions = [
  {
    name: PENKRA_EXEC_COMMAND_NAME,
    description: PENKRA_EXEC_COMMAND_DESCRIPTION,
    inputSchema: PENKRA_EXEC_COMMAND_INPUT_SCHEMA,
  },
];
const createPlugin = (source: string) =>
  new Function(
    "tool",
    "randomUUID",
    "fetch",
    "process",
    source
      .replace("import {tool} from '@opencode-ai/plugin';", "")
      .replace("import {randomUUID} from 'node:crypto';", "")
      .replace("export const PenkraGateway=", "const PenkraGateway=") + "\nreturn PenkraGateway;",
  );

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
  it("matches the complete canonical native input schema and rejects an unexpected surface", async () => {
    const plugin = await createPlugin(openCodeGatewayPluginSource(definitions))(
      { schema: z },
      () => "request",
      undefined,
      { env: {} },
    )();
    const command = z.object(plugin.tool[PENKRA_EXEC_COMMAND_NAME].args).strict();
    expect(z.toJSONSchema(command)).toEqual(PENKRA_EXEC_COMMAND_INPUT_SCHEMA);
    expect(command.parse({ command: "penkra --help" })).toEqual({ command: "penkra --help" });
    expect(command.safeParse({ command: "" }).success).toBe(false);
    expect(() => openCodeGatewayPluginSource([])).toThrow("canonical host tool");
    expect(() => openCodeGatewayPluginSource([...definitions, ...definitions])).toThrow(
      "canonical host tool",
    );
  });

  it("uses native context attribution and preserves text, images, resources and tool errors", async () => {
    const source = openCodeGatewayPluginSource(definitions);
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
    const create = createPlugin(source);
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
    const output = await plugin.tool[PENKRA_EXEC_COMMAND_NAME].execute(
      { sessionID: "forged" },
      context,
    );
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
    await expect(plugin.tool[PENKRA_EXEC_COMMAND_NAME].execute({}, context)).rejects.toThrow(
      "exact gateway error",
    );
  });
});
