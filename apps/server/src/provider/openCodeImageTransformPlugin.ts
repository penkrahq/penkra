// FILE: openCodeImageTransformPlugin.ts
// Purpose: The OpenCode plugin Penkra installs so a thread that accumulates
// many images stays usable: keep the newest four image occurrences and every
// image in the newest user message; older images become text notes. Tool
// attachments are removed and noted in the tool output, never made into text parts.
// Layer: Provider runtime utility
// Exports: OPENCODE_IMAGE_TRANSFORM_PLUGIN_SOURCE,
//          openCodeImageTransformPluginPath, ensureOpenCodeImageTransformPlugin
//
// OpenCode loads a plugin from a file path listed in the `plugin` array of its
// config. Penkra writes this file into its own directory and injects the path
// through OPENCODE_CONFIG_CONTENT (see openCodeSharedMcpConfig.ts). The file is
// self-contained: it must not import from the Penkra server bundle.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const OPENCODE_IMAGE_TRANSFORM_PLUGIN_FILE_NAME = "penkra-image-transform.js";

/**
 * A standalone OpenCode plugin. `output.messages` is `{ info, parts }[]`. The
 * newest user message keeps every image. Remaining budget goes to the newest
 * top-level file parts and tool attachments. No other nested values are touched.
 */
export const OPENCODE_IMAGE_TRANSFORM_PLUGIN_SOURCE = `// The smallest observed provider cap is 4 (HerWebCraft: "At most 4 image(s)").
// Go routes the same model to upstreams capped at 20/64 without limit metadata,
// so use one global cap; measured back-references are mostly k-1/k-2.
const IMAGE_BUDGET = 4;
const IMAGE_MIME_PREFIX = "image/";

// Match only the SDK FilePartInput shape: type "file" with an image/ mime.
const isImagePart = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  value.type === "file" &&
  typeof value.mime === "string" &&
  value.mime.startsWith(IMAGE_MIME_PREFIX);

const imageLabel = (part) => {
  const url = part.url;
  if (typeof url === "string" && url.startsWith("file:")) {
    try {
      return decodeURIComponent(new URL(url).pathname);
    } catch {
      // Fall through to the filename/mime label.
    }
  }
  if (typeof part.filename === "string" && part.filename.length > 0) return part.filename;
  return typeof part.mime === "string" && part.mime.length > 0 ? part.mime : "image";
};

const toTextPart = (part) => {
  const { url: _url, mime: _mime, filename: _filename, source: _source, type: _type, ...rest } = part;
  return { ...rest, type: "text", text: "[image: " + imageLabel(part) + "]" };
};

export const PenkraOpenCodeImageTransform = async () => ({
  "experimental.chat.messages.transform": async (_input, output) => {
    const messages = output?.messages;
    if (!Array.isArray(messages)) return;
    let newestUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.info?.role === "user") {
        newestUserIndex = index;
        break;
      }
    }
    const occurrences = [];
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const parts = messages[messageIndex]?.parts;
      if (!Array.isArray(parts)) continue;
      for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        const part = parts[partIndex];
        if (isImagePart(part)) occurrences.push({ messageIndex, parts, partIndex, image: part });
        else if (part?.type === "tool" && Array.isArray(part.state?.attachments)) {
          for (let attachmentIndex = 0; attachmentIndex < part.state.attachments.length; attachmentIndex += 1) {
            const image = part.state.attachments[attachmentIndex];
            if (isImagePart(image)) occurrences.push({ messageIndex, tool: part, attachmentIndex, image });
          }
        }
      }
    }
    const kept = new Set(occurrences.filter((entry) => entry.messageIndex === newestUserIndex));
    for (let index = occurrences.length - 1; index >= 0 && kept.size < IMAGE_BUDGET; index -= 1) {
      kept.add(occurrences[index]);
    }
    const removedByTool = new Map();
    for (const entry of occurrences) {
      if (kept.has(entry)) continue;
      if (!entry.tool) entry.parts[entry.partIndex] = toTextPart(entry.image);
      else {
        let removed = removedByTool.get(entry.tool);
        if (!removed) removedByTool.set(entry.tool, removed = new Set());
        removed.add(entry.attachmentIndex);
        if (typeof entry.tool.state.output === "string") {
          entry.tool.state.output += "\\n[image: " + imageLabel(entry.image) + "]";
        }
      }
    }
    for (const [tool, removed] of removedByTool) {
      tool.state.attachments = tool.state.attachments.filter((_attachment, index) => !removed.has(index));
    }
  },
});
`;

export function openCodeImageTransformPluginPath(homeDir: string): string {
  return path.join(
    homeDir,
    ".penkra",
    "opencode-plugins",
    OPENCODE_IMAGE_TRANSFORM_PLUGIN_FILE_NAME,
  );
}

/** Writes the plugin file when missing or stale, and returns its path. */
export async function ensureOpenCodeImageTransformPlugin(homeDir: string): Promise<string> {
  const pluginPath = openCodeImageTransformPluginPath(homeDir);
  const existing = await readFile(pluginPath, "utf8").catch(() => null);
  if (existing !== OPENCODE_IMAGE_TRANSFORM_PLUGIN_SOURCE) {
    await mkdir(path.dirname(pluginPath), { recursive: true });
    await writeFile(pluginPath, OPENCODE_IMAGE_TRANSFORM_PLUGIN_SOURCE, "utf8");
  }
  return pluginPath;
}
