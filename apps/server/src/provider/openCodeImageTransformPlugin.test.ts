import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ensureOpenCodeImageTransformPlugin,
  OPENCODE_IMAGE_TRANSFORM_PLUGIN_SOURCE,
} from "./openCodeImageTransformPlugin.ts";

interface PluginHooks {
  "experimental.chat.messages.transform": (
    input: unknown,
    output: { messages: unknown[] },
  ) => Promise<void>;
}

async function loadPluginSource(source: string): Promise<PluginHooks> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "penkra-opencode-plugin-"));
  const file = path.join(dir, "plugin.mjs");
  await writeFile(file, source, "utf8");
  const mod = (await import(pathToFileURL(file).href)) as {
    PenkraOpenCodeImageTransform: () => Promise<PluginHooks>;
  };
  return mod.PenkraOpenCodeImageTransform();
}

function fileImagePart(id: string, filePath: string) {
  return {
    id,
    sessionID: "session-1",
    messageID: "message-1",
    type: "file",
    mime: "image/png",
    filename: path.basename(filePath),
    url: pathToFileURL(filePath).href,
  };
}

describe("OpenCode image transform plugin", () => {
  it("labels older top-level images while keeping the newest user images", async () => {
    const hooks = await loadPluginSource(OPENCODE_IMAGE_TRANSFORM_PLUGIN_SOURCE);
    const messages = [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "one" }, fileImagePart("f1", "/tmp/a.png")],
      },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "ok" }] },
      {
        info: { role: "user" },
        parts: Array.from({ length: 4 }, (_, i) => fileImagePart(`f2-${i}`, "/tmp/b.png")),
      },
    ];

    await hooks["experimental.chat.messages.transform"]({}, { messages });

    expect(messages[0]!.parts).toEqual([
      { type: "text", text: "one" },
      {
        id: "f1",
        sessionID: "session-1",
        messageID: "message-1",
        type: "text",
        text: "[image: /tmp/a.png]",
      },
    ]);
    expect(messages[1]!.parts).toEqual([{ type: "text", text: "ok" }]);
    expect(messages[2]!.parts).toEqual(
      Array.from({ length: 4 }, (_, i) => fileImagePart(`f2-${i}`, "/tmp/b.png")),
    );
  });

  it("removes old tool images, labels output and preserves non-images and deeper values", async () => {
    const hooks = await loadPluginSource(OPENCODE_IMAGE_TRANSFORM_PLUGIN_SOURCE);
    const pdf = { type: "file", mime: "application/pdf", url: "file:///tmp/a.pdf" };
    const nested = fileImagePart("nested", "/tmp/nested.png");
    const tool = {
      type: "tool",
      state: { output: "Read", attachments: [fileImagePart("old", "/tmp/old.png"), pdf], nested },
    };
    const messages = [
      { info: { role: "assistant" }, parts: [tool] },
      {
        info: { role: "user" },
        parts: Array.from({ length: 4 }, (_, i) => fileImagePart(`new-${i}`, "/tmp/new.png")),
      },
    ];
    await hooks["experimental.chat.messages.transform"]({}, { messages });
    expect(tool.state.attachments).toEqual([pdf]);
    expect(tool.state.attachments[0]).toBe(pdf);
    expect(tool.state.output).toBe("Read\n[image: /tmp/old.png]");
    expect(tool.state.nested).toBe(nested);
  });

  it("keeps the newest four current-turn tool screenshots", async () => {
    const hooks = await loadPluginSource(OPENCODE_IMAGE_TRANSFORM_PLUGIN_SOURCE);
    const tools = Array.from({ length: 5 }, (_, i) => ({
      type: "tool",
      state: { output: "Read", attachments: [fileImagePart(`shot-${i}`, `/tmp/shot-${i}.png`)] },
    }));
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "Screenshot" }] },
      { info: { role: "assistant" }, parts: tools },
    ];
    await hooks["experimental.chat.messages.transform"]({}, { messages });
    expect(tools[0]!.state.attachments).toEqual([]);
    expect(tools[0]!.state.output).toBe("Read\n[image: /tmp/shot-0.png]");
    for (let i = 1; i < 5; i++)
      expect(tools[i]!.state.attachments).toEqual([
        fileImagePart(`shot-${i}`, `/tmp/shot-${i}.png`),
      ]);
    for (const tool of tools)
      for (const attachment of tool.state.attachments) {
        expect(typeof attachment.mime).toBe("string");
        expect(typeof attachment.url).toBe("string");
      }
  });

  it("keeps all six newest-user images and labels every other image", async () => {
    const hooks = await loadPluginSource(OPENCODE_IMAGE_TRANSFORM_PLUGIN_SOURCE);
    const userImages = Array.from({ length: 6 }, (_, i) =>
      fileImagePart(`user-${i}`, `/tmp/user-${i}.png`),
    );
    const tool = {
      type: "tool",
      state: { output: null, attachments: [fileImagePart("tool", "/tmp/tool.png")] },
    };
    const messages = [
      { info: { role: "assistant" }, parts: [fileImagePart("old", "/tmp/old.png")] },
      { info: { role: "user" }, parts: userImages },
      { info: { role: "assistant" }, parts: [tool] },
    ];
    await hooks["experimental.chat.messages.transform"]({}, { messages });
    expect(messages[0]!.parts[0]).toMatchObject({ type: "text", text: "[image: /tmp/old.png]" });
    expect(messages[1]!.parts).toEqual(userImages);
    expect(tool.state.attachments).toEqual([]);
    expect(tool.state.output).toBeNull();
  });

  it("handles data: URLs, falling back to the filename or mime", async () => {
    const hooks = await loadPluginSource(OPENCODE_IMAGE_TRANSFORM_PLUGIN_SOURCE);
    const messages = [
      {
        info: { role: "user" },
        parts: [
          {
            id: "data-1",
            sessionID: "session-1",
            messageID: "message-1",
            type: "file",
            mime: "image/png",
            filename: "pasted.png",
            url: "data:image/png;base64,AAAA",
          },
          {
            id: "data-2",
            sessionID: "session-1",
            messageID: "message-1",
            type: "file",
            mime: "image/jpeg",
            url: "data:image/jpeg;base64,BBBB",
          },
        ],
      },
      {
        info: { role: "user" },
        parts: Array.from({ length: 4 }, (_, i) => fileImagePart(`f-new-${i}`, "/tmp/newest.png")),
      },
    ];

    await hooks["experimental.chat.messages.transform"]({}, { messages });

    expect(messages[0]!.parts).toEqual([
      {
        id: "data-1",
        sessionID: "session-1",
        messageID: "message-1",
        type: "text",
        text: "[image: pasted.png]",
      },
      {
        id: "data-2",
        sessionID: "session-1",
        messageID: "message-1",
        type: "text",
        text: "[image: image/jpeg]",
      },
    ]);
  });

  it("labels a part with no path by its mime", async () => {
    const hooks = await loadPluginSource(OPENCODE_IMAGE_TRANSFORM_PLUGIN_SOURCE);
    const messages = [
      {
        info: { role: "user" },
        parts: [
          {
            id: "no-filename",
            type: "file",
            mime: "image/webp",
            url: "data:image/webp;base64,AAAA",
          },
          { id: "remote", type: "file", mime: "image/gif", url: "https://example.com/x.gif" },
        ],
      },
      {
        info: { role: "user" },
        parts: Array.from({ length: 4 }, (_, i) => fileImagePart(`f-new-${i}`, "/tmp/newest.png")),
      },
    ];

    await hooks["experimental.chat.messages.transform"]({}, { messages });

    expect(messages[0]!.parts).toEqual([
      { id: "no-filename", type: "text", text: "[image: image/webp]" },
      { id: "remote", type: "text", text: "[image: image/gif]" },
    ]);
  });

  it("leaves non-image file parts alone", async () => {
    const hooks = await loadPluginSource(OPENCODE_IMAGE_TRANSFORM_PLUGIN_SOURCE);
    const pdfPart = {
      id: "pdf-1",
      sessionID: "session-1",
      messageID: "message-1",
      type: "file",
      mime: "application/pdf",
      filename: "doc.pdf",
      url: pathToFileURL("/tmp/doc.pdf").href,
    };
    const messages = [
      { info: { role: "user" }, parts: [pdfPart] },
      {
        info: { role: "user" },
        parts: Array.from({ length: 4 }, (_, i) => fileImagePart(`f-new-${i}`, "/tmp/newest.png")),
      },
    ];

    await hooks["experimental.chat.messages.transform"]({}, { messages });

    expect(messages[0]!.parts).toEqual([pdfPart]);
  });

  it("keeps a 25-image conversation usable: the newest four keep image parts", async () => {
    const hooks = await loadPluginSource(OPENCODE_IMAGE_TRANSFORM_PLUGIN_SOURCE);
    const messages = Array.from({ length: 25 }, (_, index) => ({
      info: { role: "user" },
      parts: [fileImagePart(`f${index}`, `/tmp/image-${index}.png`)],
    }));

    await hooks["experimental.chat.messages.transform"]({}, { messages });

    for (let index = 0; index < 21; index += 1) {
      expect(messages[index]!.parts).toEqual([
        {
          id: `f${index}`,
          sessionID: "session-1",
          messageID: "message-1",
          type: "text",
          text: `[image: /tmp/image-${index}.png]`,
        },
      ]);
    }
    for (let index = 21; index < 25; index++)
      expect(messages[index]!.parts).toEqual([
        fileImagePart(`f${index}`, `/tmp/image-${index}.png`),
      ]);
    expect(messages[24]!.parts).toEqual([fileImagePart("f24", "/tmp/image-24.png")]);
  });

  it("writes the plugin file and returns its path", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "penkra-opencode-plugin-home-"));
    const pluginPath = await ensureOpenCodeImageTransformPlugin(home);
    expect(await readFile(pluginPath, "utf8")).toBe(OPENCODE_IMAGE_TRANSFORM_PLUGIN_SOURCE);
    await writeFile(pluginPath, "stale plugin");
    expect(await ensureOpenCodeImageTransformPlugin(home)).toBe(pluginPath);
    expect(await readFile(pluginPath, "utf8")).toBe(OPENCODE_IMAGE_TRANSFORM_PLUGIN_SOURCE);
  });
});
