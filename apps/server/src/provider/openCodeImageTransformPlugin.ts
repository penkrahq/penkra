// FILE: openCodeImageTransformPlugin.ts
// Purpose: The OpenCode plugin Penkra installs so a thread that accumulates
// many images stays usable: only the newest user message keeps image parts;
// every image part in every other message (any role or nesting) becomes the
// text `[image: <path or filename or mime>]`.
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
 * newest user message keeps its image parts; every image part anywhere else is
 * replaced by a text part. Image parts are recognised by an `image/` mime (or a
 * `data:image/` URL), so both `file:` and `data:` shapes are handled.
 */
export const OPENCODE_IMAGE_TRANSFORM_PLUGIN_SOURCE = `const IMAGE_MIME_PREFIX = "image/";

const readMime = (part) =>
  part.mime ?? part.mediaType ?? part.media_type ?? part.mimeType;

const isImagePart = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const mime = readMime(value);
  if (typeof mime === "string" && mime.startsWith(IMAGE_MIME_PREFIX)) return true;
  if (value.type === "image") return true;
  const url = value.url;
  return typeof url === "string" && url.startsWith("data:" + IMAGE_MIME_PREFIX);
};

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
  const mime = readMime(part);
  return typeof mime === "string" && mime.length > 0 ? mime : "image";
};

const toTextPart = (part) => {
  const {
    url: _url,
    data: _data,
    mime: _mime,
    mediaType: _mediaType,
    media_type: _mediaTypeSnake,
    mimeType: _mimeType,
    filename: _filename,
    type: _type,
    ...rest
  } = part;
  return { ...rest, type: "text", text: "[image: " + imageLabel(part) + "]" };
};

const replaceImagePartsInPlace = (value) => {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const child = value[index];
      if (isImagePart(child)) value[index] = toTextPart(child);
      else replaceImagePartsInPlace(child);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (isImagePart(child)) value[key] = toTextPart(child);
      else replaceImagePartsInPlace(child);
    }
  }
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
    for (let index = 0; index < messages.length; index += 1) {
      if (index === newestUserIndex) continue;
      const message = messages[index];
      if (!message || typeof message !== "object") continue;
      replaceImagePartsInPlace(message.parts);
    }
  },
});
`;

export function openCodeImageTransformPluginPath(homeDir: string): string {
  return path.join(homeDir, ".penkra", "opencode-plugins", OPENCODE_IMAGE_TRANSFORM_PLUGIN_FILE_NAME);
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
