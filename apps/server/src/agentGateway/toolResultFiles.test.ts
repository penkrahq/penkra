import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { INLINE_TOOL_RESULT_BYTES } from "@penkra/shared/toolResults";
import { mcpToolResultError, mcpToolResultJson, mcpToolResultText } from "./protocol.ts";
import { boundMcpToolResult } from "./toolResultFiles.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function stateDir() {
  const directory = await mkdtemp(join(tmpdir(), "penkra-tool-results-"));
  directories.push(directory);
  return directory;
}

describe("provider-facing tool result files", () => {
  it.each([INLINE_TOOL_RESULT_BYTES - 1, INLINE_TOOL_RESULT_BYTES])(
    "returns a %i-byte result unchanged inline",
    async (bytes) => {
      const directory = await stateDir();
      const result = mcpToolResultText("x".repeat(bytes));
      expect(
        await boundMcpToolResult({
          stateDir: directory,
          threadId: "thread-1",
          opId: "op-1",
          result,
        }),
      ).toBe(result);
      await expect(stat(join(directory, "tool-results"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([
    "x".repeat(INLINE_TOOL_RESULT_BYTES + 1),
    "é".repeat(INLINE_TOOL_RESULT_BYTES / 2) + "x",
  ])("writes the full over-budget UTF-8 result to its thread's operation file", async (text) => {
    const directory = await stateDir();
    const output = await boundMcpToolResult({
      stateDir: directory,
      threadId: "thread-1",
      opId: "op-1",
      result: mcpToolResultText(text),
    });
    const reference = JSON.parse((output.content[0] as { text: string }).text);
    expect(reference).toEqual({
      resultFile: join(directory, "tool-results", "thread-1", "op-1.txt"),
      bytes: Buffer.byteLength(text, "utf8"),
    });
    expect(await readFile(reference.resultFile, "utf8")).toBe(text);
    if (process.platform !== "win32")
      expect((await stat(reference.resultFile)).mode & 0o777).toBe(0o600);
  });

  it("keeps multibyte text at the byte boundary inline", async () => {
    const result = mcpToolResultText("é".repeat(INLINE_TOOL_RESULT_BYTES / 2));
    expect(
      await boundMcpToolResult({
        stateDir: await stateDir(),
        threadId: "thread-1",
        opId: "op-1",
        result,
      }),
    ).toBe(result);
  });

  it("preserves a complete JSON operation result and its error flag", async () => {
    const result = mcpToolResultError(
      JSON.stringify({
        primary: "x".repeat(INLINE_TOOL_RESULT_BYTES),
        secondary: ["rollback failed"],
      }),
    );
    const output = await boundMcpToolResult({
      stateDir: await stateDir(),
      threadId: "thread-1",
      opId: "op-1",
      result,
    });
    expect(output.isError).toBe(true);
    const reference = JSON.parse((output.content[0] as { text: string }).text);
    expect(await readFile(reference.resultFile, "utf8")).toBe(
      (result.content[0] as { text: string }).text,
    );
  });

  it("preserves all rich and image blocks when the full result exceeds the budget", async () => {
    const result = {
      content: [
        {
          type: "image" as const,
          data: "x".repeat(INLINE_TOOL_RESULT_BYTES),
          mimeType: "image/png",
        },
      ],
      structuredContent: { caption: "full image" },
    };
    const output = await boundMcpToolResult({
      stateDir: await stateDir(),
      threadId: "thread-1",
      opId: "op-1",
      result,
    });
    const reference = JSON.parse((output.content[0] as { text: string }).text);
    expect(JSON.parse(await readFile(reference.resultFile, "utf8"))).toEqual(result);
  });

  it("never overwrites an earlier operation result", async () => {
    const input = {
      stateDir: await stateDir(),
      threadId: "thread-1",
      opId: "op-1",
      result: mcpToolResultJson({ text: "x".repeat(INLINE_TOOL_RESULT_BYTES) }),
    };
    const output = await boundMcpToolResult(input);
    await expect(
      boundMcpToolResult({
        ...input,
        result: mcpToolResultText("y".repeat(INLINE_TOOL_RESULT_BYTES + 1)),
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    const reference = JSON.parse((output.content[0] as { text: string }).text);
    expect(await readFile(reference.resultFile, "utf8")).toBe(
      (input.result.content[0] as { text: string }).text,
    );
  });
});
