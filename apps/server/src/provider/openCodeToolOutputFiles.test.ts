import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Part } from "@opencode-ai/sdk/v2";
import { describe, expect, it } from "vitest";
import { relocateOpenCodeToolOutputFiles } from "./openCodeToolOutputFiles.ts";

describe("OpenCode tool-output relocation", () => {
  it("preserves owned file attachments on messages and completed tools", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "penkra-opencode-output-"));
    try {
      const source = path.join(root, "source");
      await mkdir(source);
      const file = path.join(source, "image.png");
      await writeFile(file, Buffer.from([1, 2, 3]));
      const attachment = { type: "file", mime: "image/png", url: pathToFileURL(file).href } as Part;
      const tool = {
        type: "tool",
        state: { status: "completed", output: "image", metadata: {}, attachments: [attachment] },
      } as Part;
      const moved = await relocateOpenCodeToolOutputFiles(
        [attachment, tool],
        source,
        path.join(root, "target"),
      );
      const image = moved[0]!;
      const result = moved[1]!;
      if (image.type !== "file" || result.type !== "tool" || result.state.status !== "completed")
        throw new Error("Missing attachments");
      expect(result.state.attachments?.[0]?.url).toBe(image.url);
      await rm(source, { recursive: true });
      expect(await readFile(fileURLToPath(image.url))).toEqual(Buffer.from([1, 2, 3]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the full output readable after deleting the source and is repeatable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "penkra-opencode-output-"));
    try {
      const source = path.join(root, "source");
      const target = path.join(root, "target");
      await mkdir(source);
      const file = path.join(source, "tool_123");
      await writeFile(file, "complete output\n");
      const original = [
        {
          type: "tool",
          state: {
            status: "completed",
            output: `Read ${file}`,
            metadata: { truncated: true, outputPath: file },
          },
        },
      ] as unknown as Part[];
      const moved = await relocateOpenCodeToolOutputFiles(original, source, target);
      expect(await relocateOpenCodeToolOutputFiles(original, source, target)).toEqual(moved);
      expect(original[0]).toMatchObject({ state: { metadata: { outputPath: file } } });
      const part = moved[0]!;
      if (part.type !== "tool" || part.state.status !== "completed")
        throw new Error("Missing tool");
      const destination = part.state.metadata.outputPath as string;
      expect(destination.startsWith(target + path.sep)).toBe(true);
      expect(part.state.output).toBe(`Read ${destination}`);
      await rm(source, { recursive: true });
      expect(await readFile(destination, "utf8")).toBe("complete output\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails on missing owned output without changing unrelated text or external references", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "penkra-opencode-output-"));
    try {
      const source = path.join(root, "source");
      const target = path.join(root, "target");
      const parts = [
        { type: "text", text: source },
        {
          type: "tool",
          state: {
            status: "completed",
            output: "external",
            metadata: { outputPath: path.join(root, "elsewhere") },
          },
        },
      ] as unknown as Part[];
      expect(await relocateOpenCodeToolOutputFiles(parts, source, target)).toEqual(parts);
      const missing = [
        {
          type: "tool",
          state: {
            status: "completed",
            output: "missing",
            metadata: { outputPath: path.join(source, "missing") },
          },
        },
      ] as unknown as Part[];
      await expect(relocateOpenCodeToolOutputFiles(missing, source, target)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses corrupt destinations and source links escaping the owned root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "penkra-opencode-output-"));
    try {
      const source = path.join(root, "source");
      const target = path.join(root, "target");
      await mkdir(source);
      const file = path.join(source, "tool_123");
      await writeFile(file, "original");
      const parts = [
        {
          type: "tool",
          state: { status: "completed", output: file, metadata: { outputPath: file } },
        },
      ] as unknown as Part[];
      const moved = await relocateOpenCodeToolOutputFiles(parts, source, target);
      const part = moved[0]!;
      if (part.type !== "tool" || part.state.status !== "completed")
        throw new Error("Missing tool");
      await writeFile(part.state.metadata.outputPath as string, "corrupt");
      await expect(relocateOpenCodeToolOutputFiles(parts, source, target)).rejects.toThrow(
        "does not match",
      );
      expect(await readFile(file, "utf8")).toBe("original");
      const outside = path.join(root, "outside");
      await writeFile(outside, "external");
      await rm(file);
      await symlink(outside, file);
      await expect(relocateOpenCodeToolOutputFiles(parts, source, target)).rejects.toThrow(
        "inside its source data root",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
