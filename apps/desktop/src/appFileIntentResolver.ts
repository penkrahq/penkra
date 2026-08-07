// FILE: appFileIntentResolver.ts
// Purpose: Resolves files by exact extension, then routes otherwise-unclaimed UTF-8 text as .txt.
// Layer: Trusted desktop App routing boundary

import * as FS from "node:fs";
import * as Path from "node:path";

import type { AppIntentRouter, ResolvedAppIntent } from "./appIntentRouter";
import type { AppOpenWithPreferenceStore } from "./appOpenWithPreferences";

const TEXT_SAMPLE_BYTES = 64 * 1024;

export async function resolvePathIntent(input: {
  intents: AppIntentRouter;
  kind: "directory" | "file";
  openWith: AppOpenWithPreferenceStore;
  path: string;
  requestedApp?: string;
  spaceId: string;
}): Promise<ResolvedAppIntent | null> {
  if (input.kind === "file") return resolveFileIntent(input);
  const intent = "open-directory";
  const preferredAppId = input.openWith.get(input.spaceId, intent);
  return input.intents.resolve(input.spaceId, {
    intent,
    ...(input.requestedApp ? { requestedApp: input.requestedApp } : {}),
    ...(preferredAppId ? { preferredAppId } : {}),
  });
}

export async function resolveFileIntent(input: {
  intents: AppIntentRouter;
  openWith: AppOpenWithPreferenceStore;
  path: string;
  requestedApp?: string;
  spaceId: string;
}): Promise<ResolvedAppIntent | null> {
  const extension = Path.extname(input.path).toLowerCase();
  const exactRequest = {
    intent: "open-file" as const,
    extension,
    ...(input.requestedApp ? { requestedApp: input.requestedApp } : {}),
    ...preferredApp(input.openWith, input.spaceId, extension),
  };

  if (input.intents.candidates(input.spaceId, exactRequest).length > 0) {
    return input.intents.resolve(input.spaceId, exactRequest);
  }

  if (await hasUtf8TextPrefix(input.path)) {
    const textExtension = ".txt";
    return input.intents.resolve(input.spaceId, {
      intent: "open-file",
      extension: textExtension,
      ...(input.requestedApp ? { requestedApp: input.requestedApp } : {}),
      ...preferredApp(input.openWith, input.spaceId, textExtension),
    });
  }

  // Preserve the requested-handler error for an explicit incompatible App.
  return input.intents.resolve(input.spaceId, exactRequest);
}

async function hasUtf8TextPrefix(path: string): Promise<boolean> {
  const file = await FS.promises.open(path, "r");
  try {
    const sample = Buffer.alloc(TEXT_SAMPLE_BYTES + 1);
    const { bytesRead } = await file.read(sample, 0, sample.length, 0);
    const bytes = sample.subarray(0, Math.min(bytesRead, TEXT_SAMPLE_BYTES));
    if (bytes.includes(0)) return false;
    try {
      // A bounded prefix may end in the middle of a valid multi-byte character.
      new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
        stream: bytesRead > TEXT_SAMPLE_BYTES,
      });
      return true;
    } catch {
      return false;
    }
  } finally {
    await file.close();
  }
}

function preferredApp(
  openWith: AppOpenWithPreferenceStore,
  spaceId: string,
  extension: string,
): { preferredAppId?: string } {
  const preferredAppId = openWith.get(spaceId, "open-file", extension);
  return preferredAppId ? { preferredAppId } : {};
}
