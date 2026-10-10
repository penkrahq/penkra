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
  it("keeps image parts only in the newest user message", async () => {
    const hooks = await loadPluginSource(OPENCODE_IMAGE_TRANSFORM_PLUGIN_SOURCE);
    const messages = [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "one" }, fileImagePart("f1", "/tmp/a.png")],
      },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "ok" }] },
      { info: { role: "user" }, parts: [fileImagePart("f2", "/tmp/b.png")] },
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
    expect(messages[2]!.parts).toEqual([fileImagePart("f2", "/tmp/b.png")]);
  });

  it("replaces images in assistant and tool-result messages of any nesting", async () => {
    const hooks = await loadPluginSource(OPENCODE_IMAGE_TRANSFORM_PLUGIN_SOURCE);
    const nestedImage = fileImagePart("f-tool", "/tmp/screenshot.png");
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "read",
            state: { status: "completed", attachments: [nestedImage] },
          },
        ],
      },
      { info: { role: "user" }, parts: [fileImagePart("f-new", "/tmp/newest.png")] },
    ];

    await hooks["experimental.chat.messages.transform"]({}, { messages });

    expect((messages[0]!.parts as Array<Record<string, unknown>>)[0]).toEqual({
      type: "tool",
      tool: "read",
      state: {
        status: "completed",
        attachments: [
          {
            id: "f-tool",
            sessionID: "session-1",
            messageID: "message-1",
            type: "text",
            text: "[image: /tmp/screenshot.png]",
          },
        ],
      },
    });
    expect(messages[1]!.parts).toEqual([fileImagePart("f-new", "/tmp/newest.png")]);
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
      { info: { role: "user" }, parts: [fileImagePart("f-new", "/tmp/newest.png")] },
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
          { id: "no-url", type: "image", mime: "image/webp" },
          { id: "remote", type: "file", mime: "image/gif", url: "https://example.com/x.gif" },
        ],
      },
      { info: { role: "user" }, parts: [fileImagePart("f-new", "/tmp/newest.png")] },
    ];

    await hooks["experimental.chat.messages.transform"]({}, { messages });

    expect(messages[0]!.parts).toEqual([
      { id: "no-url", type: "text", text: "[image: image/webp]" },
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
      { info: { role: "user" }, parts: [fileImagePart("f-new", "/tmp/newest.png")] },
    ];

    await hooks["experimental.chat.messages.transform"]({}, { messages });

    expect(messages[0]!.parts).toEqual([pdfPart]);
  });

  it("keeps a 25-image conversation usable: only the newest keeps image parts", async () => {
    const hooks = await loadPluginSource(OPENCODE_IMAGE_TRANSFORM_PLUGIN_SOURCE);
    const messages = Array.from({ length: 25 }, (_, index) => ({
      info: { role: "user" },
      parts: [fileImagePart(`f${index}`, `/tmp/image-${index}.png`)],
    }));

    await hooks["experimental.chat.messages.transform"]({}, { messages });

    for (let index = 0; index < 24; index += 1) {
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
    expect(messages[24]!.parts).toEqual([fileImagePart("f24", "/tmp/image-24.png")]);
  });

  it("writes the plugin file and returns its path", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "penkra-opencode-plugin-home-"));
    const pluginPath = await ensureOpenCodeImageTransformPlugin(home);
    expect(await readFile(pluginPath, "utf8")).toBe(OPENCODE_IMAGE_TRANSFORM_PLUGIN_SOURCE);
  });
});
