import type { PenkraControllerRuntimeApi } from "./runtime";

function runtime(): PenkraControllerRuntimeApi {
  const candidate = (globalThis as { penkra?: PenkraControllerRuntimeApi }).penkra;
  if (!candidate) {
    throw new Error("Penkra App runtime is unavailable. Run this package inside Penkra.");
  }
  if (candidate.runtime?.kind !== "controller") {
    throw new Error(
      "@penkra/sdk/controller is available only in a Node operation controller. Import @penkra/sdk/tab from a visual App tab.",
    );
  }
  return candidate;
}

export const operations: PenkraControllerRuntimeApi["operations"] = {
  handle: (handlerKey, handler) => runtime().operations.handle(handlerKey, handler),
};

export const controller: PenkraControllerRuntimeApi["controller"] = {
  handle: (handler, callback) => runtime().controller.handle(handler, callback),
};

export const shell: PenkraControllerRuntimeApi["shell"] = {
  beep: () => runtime().shell.beep(),
  openExternal: (url, options) => runtime().shell.openExternal(url, options),
  openPath: (path) => runtime().shell.openPath(path),
  showItemInFolder: (fullPath) => runtime().shell.showItemInFolder(fullPath),
  trashItem: (path) => runtime().shell.trashItem(path),
  readShortcutLink: (shortcutPath) => runtime().shell.readShortcutLink(shortcutPath),
  writeShortcutLink: ((shortcutPath: string, operationOrOptions: unknown, options?: unknown) =>
    options === undefined
      ? runtime().shell.writeShortcutLink(shortcutPath, operationOrOptions as never)
      : runtime().shell.writeShortcutLink(
          shortcutPath,
          operationOrOptions as never,
          options as never,
        )) as PenkraControllerRuntimeApi["shell"]["writeShortcutLink"],
};

export const identity: PenkraControllerRuntimeApi["identity"] = {
  get: () => runtime().identity.get(),
  getToken: (input) => runtime().identity.getToken(input),
};

export const account: PenkraControllerRuntimeApi["account"] = {
  request: (input) => runtime().account.request(input),
};

export const settings: PenkraControllerRuntimeApi["settings"] = {
  get: (key) => runtime().settings.get(key),
  set: (key, value) => runtime().settings.set(key, value),
  reset: (key) => runtime().settings.reset(key),
};

export const secrets: PenkraControllerRuntimeApi["secrets"] = {
  get: (name) => runtime().secrets.get(name),
  set: (name, value) => runtime().secrets.set(name, value),
  delete: (name) => runtime().secrets.delete(name),
};

export const permissions: PenkraControllerRuntimeApi["permissions"] = {
  query: (name) => runtime().permissions.query(name),
};

export type { PenkraControllerRuntimeApi } from "./runtime";
export type { AppOperationHandler } from "./runtime";
export type {
  AppControllerRequestContext,
  AppControllerRequestHandler,
  AppShellApi,
  AppShellOpenExternalOptions,
  AppShellShortcutDetails,
} from "./runtime";
export type {
  AppOperationContent,
  AppOperationRichResult,
  AppTabHandle,
  AppTabs,
  OperationAddress,
  OperationCancellationCode,
  OperationContext,
  OperationInvocation,
  OperationRequest,
} from "./operations";
