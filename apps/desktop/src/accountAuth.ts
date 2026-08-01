// FILE: accountAuth.ts
// Purpose: Owns Penkra account authentication in Electron's main process.
// Layer: Desktop main process
// Depends on: Better Auth's Electron client, encrypted OS storage, and narrow IPC channels.

import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { app, type BrowserWindow, type IpcMain } from "electron";
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
  setupMain: (config: {
    bridges: boolean;
    csp: boolean;
    getWindow: () => BrowserWindow | null;
    scheme: boolean;
  }) => void;
};

export function configurePenkraAccountAuth(input: {
  accountAuthScheme: string;
  authBaseUrl: string;
  desktopFlavor: PenkraDesktopFlavor;
  getWindow: () => BrowserWindow | null;
  ipcMain: IpcMain;
  registerAsDefaultProtocolClient?: boolean;
  websiteOrigin: string;
}): void {
  const accountStorage = storage({
    configName: `account-auth-${input.desktopFlavor}-${serviceKey(input.authBaseUrl)}`,
    projectName: "Penkra",
  });
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
    storagePrefix: "penkra-account",
    userImageProxy: {
      enabled: false,
    },
  } as const;
  const createPenkraAuthClient = (path: "/sign-in" | "/sign-up") => {
    const signInUrl = new URL(path, input.websiteOrigin);
    if (input.desktopFlavor !== "production") {
      signInUrl.searchParams.set("desktop_flavor", input.desktopFlavor);
    }
    const plugin = electronClient({
      ...electronOptions,
      signInURL: signInUrl.toString(),
    });
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
  let callbackAttempt = 0;

  const completeAuthCallback = async (url: string | undefined) => {
    if (!url) return;
    const token = readPenkraAccountAuthCallbackToken(url, input.accountAuthScheme);
    if (!token) return;
    const attempt = ++callbackAttempt;
    const callbackIntent = pendingIntent;
    pendingIntent = null;
    input.getWindow()?.webContents.send(DESKTOP_IPC_CHANNELS.accountAuth.callbackStarted, {
      intent: callbackIntent,
    });
    const timeout = setTimeout(() => {
      if (attempt !== callbackAttempt) return;
      callbackAttempt += 1;
      input.getWindow()?.webContents.send(DESKTOP_IPC_CHANNELS.accountAuth.error, {
        message: "Authentication did not complete. Please try again.",
      });
    }, AUTH_CALLBACK_TIMEOUT_MS);
    try {
      const result = await signInClient.authenticate({ token });
      if (attempt !== callbackAttempt) return;
      callbackAttempt += 1;
      clearTimeout(timeout);
      if (result.error || !result.data?.user) {
        input.getWindow()?.webContents.send(DESKTOP_IPC_CHANNELS.accountAuth.error, {
          message: result.error?.message || "Authentication did not complete. Please try again.",
        });
        return;
      }
      // authenticate() emits the channel-prefixed authenticated event after it
      // stores the returned session. Do not send a second copy here.
    } catch {
      if (attempt !== callbackAttempt) return;
      callbackAttempt += 1;
      clearTimeout(timeout);
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
    if (process.platform === "darwin") return;
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
    getWindow: input.getWindow,
    scheme: BETTER_AUTH_PROTOCOL_REGISTRATION_ENABLED,
  });

  input.ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.accountAuth.getState);
  input.ipcMain.handle(DESKTOP_IPC_CHANNELS.accountAuth.getState, async (event) => {
    if (event.sender !== input.getWindow()?.webContents) return authError("Authentication failed.");
    const result = await signInClient.getSession();
    if (result.error) return authError(result.error.message);
    const user = result.data?.user;
    return user
      ? { status: "authenticated", user: toDesktopAccountUser(user) }
      : { status: "unauthenticated" };
  });

  input.ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.accountAuth.requestSignIn);
  input.ipcMain.handle(DESKTOP_IPC_CHANNELS.accountAuth.requestSignIn, async (event) => {
    if (event.sender !== input.getWindow()?.webContents) return;
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
    if (event.sender !== input.getWindow()?.webContents) return;
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
    if (event.sender !== input.getWindow()?.webContents) return;
    await signInClient.signOut();
    input.getWindow()?.webContents.send(DESKTOP_IPC_CHANNELS.accountAuth.userUpdated, null);
  });
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
