// FILE: accountAuth.ts
// Purpose: Owns Penkra account authentication in Electron's main process.
// Layer: Desktop main process
// Depends on: Better Auth's Electron client, encrypted OS storage, and narrow IPC channels.

import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { app, type BrowserWindow, type IpcMain, type WebContents } from "electron";
import { electronClient } from "@better-auth/electron/client";
import { storage } from "@better-auth/electron/storage";
import { createAuthClient } from "better-auth/client";

import type { DesktopAccountAuthState, DesktopAccountUser } from "@penkra/contracts";
import type { PenkraDesktopFlavor } from "@penkra/shared/desktopIdentity";
import {
  PENKRA_ACCOUNT_AUTH_CALLBACK_PATH,
  readPenkraAccountAuthCallbackToken,
} from "./accountAuthCallback";
import { BETTER_AUTH_PROTOCOL_REGISTRATION_ENABLED } from "./desktopProtocolSchemes";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import { resolvePenkraAccountSignInUrl } from "./accountAuthSignInUrl";
import { ACCOUNT_STORAGE_PREFIX, AccountSessionCache } from "./accountSessionCache";

export const PENKRA_DESKTOP_AUTH_CLIENT_ID = "penkra-desktop";
const AUTH_CHANNEL_PREFIX = "penkra-account";
const AUTH_CALLBACK_TIMEOUT_MS = 20_000;
type AuthIntent = "sign-in" | "sign-up";
type PenkraElectronAuthClient = ReturnType<typeof createAuthClient> & {
  authenticate: (input: { token: string }) => Promise<{
    data: { user: Record<string, unknown> } | null;
    error: { message?: string } | null;
  }>;
  requestAuth: () => Promise<void>;
  getCookie: () => string;
  setupMain: (config: {
    bridges: boolean;
    csp: boolean;
    getWindow: () => BrowserWindow | null;
    scheme: boolean;
  }) => void;
};

export type PenkraAccountAuthRuntime = {
  getCookie: () => string;
  getAccountId: () => Promise<string | null>;
  /** Only cookie-authenticated requests to the configured account service. */
  fetch: typeof fetch;
};

export function configurePenkraAccountAuth(input: {
  accountAuthScheme: string;
  authBaseUrl: string;
  desktopFlavor: PenkraDesktopFlavor;
  developmentInstance?: number;
  getWindow: () => BrowserWindow | null;
  broadcast?: (channel: string, ...args: unknown[]) => void;
  isShellRenderer: (sender: WebContents) => boolean;
  ipcMain: IpcMain;
  inspectInitialProtocolUrlFromArgv: boolean;
  registerAsDefaultProtocolClient?: boolean;
  websiteOrigin: string;
  /** Successful explicit authentication, never an ordinary session read. */
  onAuthenticated?: (accountId: string) => void;
  onBeforeSignOut?: () => void | Promise<void>;
}): PenkraAccountAuthRuntime {
  const accountStorage = storage({
    configName: `account-auth-${input.desktopFlavor}-${serviceKey(input.authBaseUrl)}`,
    projectName: "Penkra",
  });
  const sessionCache = new AccountSessionCache(accountStorage);
  const serviceOrigin = new URL(input.authBaseUrl).origin;
  let callbackAttempt = 0;
  const notify = (channel: string, ...args: unknown[]) => {
    if (input.broadcast) input.broadcast(channel, ...args);
    else input.getWindow()?.webContents.send(channel, ...args);
  };
  const electronOptions = {
    callbackPath: PENKRA_ACCOUNT_AUTH_CALLBACK_PATH,
    channelPrefix: AUTH_CHANNEL_PREFIX,
    clientID: PENKRA_DESKTOP_AUTH_CLIENT_ID,
    protocol: {
      scheme: input.accountAuthScheme,
    },
    sanitizeUser: (user: {
      id: string;
      createdAt: Date;
      updatedAt: Date;
      email: string;
      emailVerified: boolean;
      name: string;
      image?: string | null | undefined;
    }) => ({
      id: user.id,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      email: user.email,
      emailVerified: user.emailVerified,
      name: user.name,
      image: user.image ?? null,
    }),
    storage: accountStorage,
    storagePrefix: ACCOUNT_STORAGE_PREFIX,
    userImageProxy: {
      enabled: false,
    },
  } as const;
  const createPenkraAuthClient = (path: "/sign-in" | "/sign-up") => {
    const signInUrl = resolvePenkraAccountSignInUrl({
      path,
      websiteOrigin: input.websiteOrigin,
      desktopFlavor: input.desktopFlavor,
      ...(input.developmentInstance === undefined
        ? {}
        : { developmentInstance: input.developmentInstance }),
    });
    const plugin = electronClient({
      ...electronOptions,
      signInURL: signInUrl.toString(),
    });
    // The request context is retained by Better Fetch through its response hooks.
    // Fence the dependency's own encrypted writes as well as our result handler:
    // a late response must never restore a session replaced by sign-in/sign-out.
    for (const fetchPlugin of plugin.fetchPlugins) {
      const hooks = fetchPlugin.hooks;
      if (!hooks) continue;
      const epochs = new WeakMap<object, number>();
      const onSuccess = hooks.onSuccess;
      const onError = hooks.onError;
      const guardedHooks = {
        ...hooks,
        onRequest: (context: Parameters<typeof onSuccess>[0]["request"]) => {
          epochs.set(context, callbackAttempt);
        },
      };
      guardedHooks.onSuccess = async (context) => {
        if (epochs.get(context.request) !== callbackAttempt) return;
        await onSuccess?.(context);
      };
      guardedHooks.onError = async (context) => {
        if (epochs.get(context.request) !== callbackAttempt) return;
        // Launch verification is reported by its owner, never as a sign-in error.
        if (new URL(context.request.url).pathname.endsWith("/get-session")) return;
        await onError?.(context);
      };
      fetchPlugin.hooks = guardedHooks;
    }
    // Better Auth 1.6.25 and its Electron package publish structurally equivalent
    // BetterFetch generics from separate declaration paths. Keep that mismatch at
    // this package boundary while retaining the Electron actions in our local type.
    return createAuthClient({
      baseURL: input.authBaseUrl,
      plugins: [plugin as never],
    }) as unknown as PenkraElectronAuthClient;
  };
  const signInClient = createPenkraAuthClient("/sign-in");
  const signUpClient = createPenkraAuthClient("/sign-up");
  let pendingIntent: AuthIntent | null = null;
  let callbackTimeout: ReturnType<typeof setTimeout> | null = null;
  const cancelCallbackTimeout = (timeout = callbackTimeout) => {
    if (timeout !== null) clearTimeout(timeout);
    if (callbackTimeout === timeout) callbackTimeout = null;
  };

  const completeAuthCallback = async (url: string | undefined) => {
    if (!url) return;
    const token = readPenkraAccountAuthCallbackToken(url, input.accountAuthScheme);
    if (!token) return;
    cancelCallbackTimeout();
    const attempt = ++callbackAttempt;
    const callbackIntent = pendingIntent;
    pendingIntent = null;
    input.getWindow()?.webContents.send(DESKTOP_IPC_CHANNELS.accountAuth.callbackStarted, {
      intent: callbackIntent,
    });
    const timeout = setTimeout(() => {
      if (attempt !== callbackAttempt) return;
      callbackAttempt += 1;
      cancelCallbackTimeout(timeout);
      input.getWindow()?.webContents.send(DESKTOP_IPC_CHANNELS.accountAuth.error, {
        message: "Authentication did not complete. Please try again.",
      });
    }, AUTH_CALLBACK_TIMEOUT_MS);
    callbackTimeout = timeout;
    try {
      const result = await signInClient.authenticate({ token });
      cancelCallbackTimeout(timeout);
      if (attempt !== callbackAttempt) return;
      if (result.error || !result.data?.user) {
        callbackAttempt += 1;
        input.getWindow()?.webContents.send(DESKTOP_IPC_CHANNELS.accountAuth.error, {
          message: result.error?.message || "Authentication did not complete. Please try again.",
        });
        return;
      }
      const user = toDesktopAccountUser(result.data.user);
      sessionCache.write(user);
      callbackAttempt += 1;
      notify(DESKTOP_IPC_CHANNELS.accountAuth.authenticated, user);
      if (typeof result.data.user.id === "string") input.onAuthenticated?.(result.data.user.id);
    } catch {
      cancelCallbackTimeout(timeout);
      if (attempt !== callbackAttempt) return;
      callbackAttempt += 1;
      input.getWindow()?.webContents.send(DESKTOP_IPC_CHANNELS.accountAuth.error, {
        message: "Authentication did not complete. Please try again.",
      });
    }
  };

  app.on("open-url", (_event, url) => {
    void completeAuthCallback(url);
  });
  app.on("second-instance", (_event, commandLine, _workingDirectory, additionalData) => {
    const callbackUrl =
      typeof additionalData === "string" &&
      readPenkraAccountAuthCallbackToken(additionalData, input.accountAuthScheme)
        ? additionalData
        : commandLine
            .toReversed()
            .find((argument) =>
              Boolean(readPenkraAccountAuthCallbackToken(argument, input.accountAuthScheme)),
            );
    void completeAuthCallback(callbackUrl);
  });
  void app.whenReady().then(() => {
    if (!input.inspectInitialProtocolUrlFromArgv) return;
    void completeAuthCallback(
      process.argv
        .toReversed()
        .find((argument) =>
          Boolean(readPenkraAccountAuthCallbackToken(argument, input.accountAuthScheme)),
        ),
    );
  });

  if (input.registerAsDefaultProtocolClient !== false) {
    const registeredAsProtocolClient = process.defaultApp
      ? typeof process.argv[1] === "string" &&
        app.setAsDefaultProtocolClient(input.accountAuthScheme, process.execPath, [
          resolve(process.argv[1]),
        ])
      : app.setAsDefaultProtocolClient(input.accountAuthScheme);
    if (!registeredAsProtocolClient) {
      console.error(`Failed to register protocol ${input.accountAuthScheme} as default client.`);
    }
  }

  signInClient.setupMain({
    bridges: false,
    csp: false,
    // Publish authentication ourselves, after the local account is durable.
    getWindow: () => null,
    scheme: BETTER_AUTH_PROTOCOL_REGISTRATION_ENABLED,
  });

  input.ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.accountAuth.getState);
  input.ipcMain.handle(DESKTOP_IPC_CHANNELS.accountAuth.getState, async (event) => {
    if (!input.isShellRenderer(event.sender)) return authError("Authentication failed.");
    const user = sessionCache.read();
    return user ? { status: "authenticated", user } : { status: "unauthenticated" };
  });

  input.ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.accountAuth.requestSignIn);
  input.ipcMain.handle(DESKTOP_IPC_CHANNELS.accountAuth.requestSignIn, async (event) => {
    if (!input.isShellRenderer(event.sender)) return;
    pendingIntent = "sign-in";
    try {
      await signInClient.requestAuth();
    } catch (error) {
      pendingIntent = null;
      throw error;
    }
  });

  input.ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.accountAuth.requestSignUp);
  input.ipcMain.handle(DESKTOP_IPC_CHANNELS.accountAuth.requestSignUp, async (event) => {
    if (!input.isShellRenderer(event.sender)) return;
    pendingIntent = "sign-up";
    try {
      await signUpClient.requestAuth();
    } catch (error) {
      pendingIntent = null;
      throw error;
    }
  });

  input.ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.accountAuth.signOut);
  input.ipcMain.handle(DESKTOP_IPC_CHANNELS.accountAuth.signOut, async (event) => {
    if (!input.isShellRenderer(event.sender)) return;
    const attempt = ++callbackAttempt;
    cancelCallbackTimeout();
    pendingIntent = null;
    await input.onBeforeSignOut?.();
    if (attempt !== callbackAttempt) return;
    // Also retire reads admitted while cleanup was waiting.
    callbackAttempt += 1;
    sessionCache.clear();
    notify(DESKTOP_IPC_CHANNELS.accountAuth.userUpdated, null);
    try {
      await signInClient.signOut();
    } catch (error) {
      console.warn("[account-auth] Server sign-out failed after local sign-out.", error);
    }
  });

  const invalidateSession = async (
    epoch: number,
    reason: "unauthorized" | "session-absent",
    path: string,
  ) => {
    if (epoch !== callbackAttempt) return;
    callbackAttempt += 1;
    cancelCallbackTimeout();
    pendingIntent = null;
    sessionCache.clear();
    console.info("[account-auth] Session invalidated.", { serviceOrigin, epoch, reason, path });
    notify(DESKTOP_IPC_CHANNELS.accountAuth.userUpdated, null);
    try {
      await input.onBeforeSignOut?.();
    } catch (error) {
      console.error("[account-auth] Invalid-session cleanup failed.", error);
    }
  };
  void app.whenReady().then(async () => {
    const epoch = callbackAttempt;
    const startedAt = performance.now();
    try {
      const result = await signInClient.getSession();
      if (epoch !== callbackAttempt) return;
      if (result.error) {
        if (result.error.status === 401)
          await invalidateSession(epoch, "unauthorized", "/get-session");
        else
          console.warn("[account-auth] Launch session check failed.", {
            serviceOrigin,
            epoch,
            status: result.error.status,
            reason: result.error.message,
            elapsedMs: performance.now() - startedAt,
          });
        return;
      }
      if (!result.data?.user) {
        await invalidateSession(epoch, "session-absent", "/get-session");
        return;
      }
      const user = toDesktopAccountUser(result.data.user);
      sessionCache.write(user);
      notify(DESKTOP_IPC_CHANNELS.accountAuth.userUpdated, user);
    } catch (error) {
      console.warn("[account-auth] Launch session check failed.", {
        serviceOrigin,
        epoch,
        reason: error instanceof Error ? error.message : String(error),
        elapsedMs: performance.now() - startedAt,
      });
    }
  });

  return {
    getCookie: () => signInClient.getCookie(),
    getAccountId: async () => sessionCache.read()?.id ?? null,
    fetch: async (request, options) => {
      const epoch = callbackAttempt;
      const url = new URL(request instanceof Request ? request.url : request.toString());
      const cookie = new Headers(
        options?.headers ?? (request instanceof Request ? request.headers : undefined),
      ).get("cookie");
      const currentCookie = signInClient.getCookie();
      const response = await fetch(request, options);
      if (
        response.status === 401 &&
        url.origin === serviceOrigin &&
        (!response.url || new URL(response.url).origin === url.origin) &&
        cookie &&
        cookie === currentCookie
      )
        await invalidateSession(epoch, "unauthorized", url.pathname);
      return response;
    },
  };
}

function serviceKey(authBaseUrl: string): string {
  return createHash("sha256").update(authBaseUrl).digest("hex").slice(0, 12);
}

function toDesktopAccountUser(user: Record<string, unknown>): DesktopAccountUser {
  return {
    id: String(user.id ?? ""),
    email: String(user.email ?? ""),
    name: String(user.name ?? ""),
    image: typeof user.image === "string" ? user.image : null,
  };
}

function authError(message?: string): DesktopAccountAuthState {
  return {
    status: "error",
    message: message?.trim() || "Authentication failed.",
  };
}
