// FILE: desktopFolderAppTabsRoute.ts
// Purpose: Give the desktop host bounded folder App-tab reads and writes without a shell window.

import {
  CleanCoreGetFolderAppTabsInput,
  CleanCoreUpdateFolderAppTabsInput,
} from "@penkra/contracts";
import { Effect, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { getFolderAppTabs, updateFolderAppTabs } from "./cleanCore/folderAppTabs.ts";
import { ServerConfig } from "./config";
import { authorizeDesktopShutdown } from "./serverShutdown";

const Request = Schema.Union([
  Schema.Struct({ action: Schema.Literal("get"), ...CleanCoreGetFolderAppTabsInput.fields }),
  Schema.Struct({ action: Schema.Literal("update"), ...CleanCoreUpdateFolderAppTabsInput.fields }),
]);

export const desktopFolderAppTabsRouteLayer = HttpRouter.add(
  "POST",
  "/api/desktop/folder-app-tabs",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const auth = authorizeDesktopShutdown({
      config,
      remoteAddress: request.remoteAddress,
      authorization: request.headers.authorization,
    });
    if (!auth.authorized)
      return HttpServerResponse.jsonUnsafe(
        { ok: false, message: auth.reason },
        { status: auth.status },
      );
    const result = yield* Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(Request)(yield* request.json);
      return input.action === "get"
        ? yield* getFolderAppTabs(input)
        : yield* updateFolderAppTabs(input);
    }).pipe(
      Effect.match({
        onSuccess: (result) => ({ ok: true as const, result }),
        onFailure: (error) => ({ ok: false as const, message: error.message }),
      }),
    );
    return HttpServerResponse.jsonUnsafe(result, { status: result.ok ? 200 : 400 });
  }),
);
