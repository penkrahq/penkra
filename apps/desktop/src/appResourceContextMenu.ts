// FILE: appResourceContextMenu.ts
// Purpose: Builds the native destination menu for one validated Thread resource.
// Layer: Trusted desktop App routing boundary

import * as Path from "node:path";

import type { DesktopResourceContextMenuInput } from "@penkra/contracts";

import type { AppIntentRouter, ResolvedAppIntent } from "./appIntentRouter";
import { resolveLocalResource, type ResolvedLocalResource } from "./appLocalResourceOpener";

export interface AppResourceMenuChoice {
  id: string;
  label: string;
  requestedApp?: string;
  destination: "app" | "system";
}

export type AppResourceContextMenuModel =
  | {
      label: "Open in";
      resource: { url: string };
      intent: "open-url";
      choices: ReadonlyArray<AppResourceMenuChoice>;
    }
  | {
      label: "Show in";
      resource: ResolvedLocalResource;
      intent: "open-file" | "open-directory";
      choices: ReadonlyArray<AppResourceMenuChoice>;
    };

export async function buildAppResourceContextMenu(input: {
  intents: AppIntentRouter;
  platform: NodeJS.Platform;
  request: DesktopResourceContextMenuInput;
}): Promise<AppResourceContextMenuModel> {
  if ((input.request.path === undefined) === (input.request.url === undefined)) {
    throw new Error("Resource context menu requires exactly one path or URL.");
  }

  if (input.request.url !== undefined) {
    const url = new URL(input.request.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only HTTP and HTTPS URLs can be opened.");
    }
    return {
      label: "Open in",
      resource: { url: url.href },
      intent: "open-url",
      choices: [
        { id: "system", label: "External Browser", destination: "system" },
        ...appChoices(
          input.intents.candidates(input.request.spaceId, {
            intent: "open-url",
            url: url.href,
          }),
        ),
      ],
    };
  }

  const resource = await resolveLocalResource(input.request.path!);
  const candidates = input.intents.candidates(
    input.request.spaceId,
    resource.kind === "directory"
      ? { intent: "open-directory" }
      : { intent: "open-file", extension: Path.extname(resource.path).toLowerCase() },
  );
  return {
    label: "Show in",
    resource,
    intent: resource.intent,
    choices: [
      ...(input.platform === "darwin"
        ? [{ id: "system", label: "Finder", destination: "system" as const }]
        : []),
      ...appChoices(candidates),
    ],
  };
}

function appChoices(candidates: ReadonlyArray<ResolvedAppIntent>): AppResourceMenuChoice[] {
  return candidates.map((candidate) => ({
    id: `app:${candidate.appId}`,
    label: candidate.name,
    requestedApp: candidate.appId,
    destination: "app",
  }));
}
