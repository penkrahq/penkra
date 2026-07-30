// FILE: accountAuth.ts
// Purpose: Owns Penkra account authentication in Electron's main process.
// Layer: Desktop main process
// Depends on: Better Auth's Electron client, encrypted OS storage, and narrow IPC channels.

import { app, type BrowserWindow, type IpcMain } from "electron";
import { electronClient } from "@better-auth/electron/client";
import { storage } from "@better-auth/electron/storage";
import { createAuthClient } from "better-auth/client";

import type {
  DesktopAccountAuthState,
  DesktopAccountUser,
} from "@synara/contracts";
import type { SynaraDesktopFlavor } from "@synara/shared/desktopIdentity";
import {
  isPenkraAccountAuthCallbackUrl,
  PENKRA_ACCOUNT_AUTH_CALLBACK_PATH,
} from "./accountAuthCallback";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

export const PENKRA_DESKTOP_AUTH_CLIENT_ID = "penkra-desktop";
const AUTH_CHANNEL_PREFIX = "penkra-account";
const AUTH_CALLBACK_TIMEOUT_MS = 20_000;
type AuthIntent = "sign-in" | "sign-up";
type PenkraElectronAuthClient = ReturnType<typeof createAuthClient> & {
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
  authOrigin: string;
  desktopFlavor: SynaraDesktopFlavor;
  getWindow: () => BrowserWindow | null;
  ipcMain: IpcMain;
}): void {
  const accountStorage = storage({
    configName: "account-auth",
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
    const signInUrl = new URL(path, input.authOrigin);
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
      baseURL: input.authOrigin,
      plugins: [plugin as never],
    }) as unknown as PenkraElectronAuthClient;
  };
  const signInClient = createPenkraAuthClient("/sign-in");
  const signUpClient = createPenkraAuthClient("/sign-up");
  let pendingIntent: AuthIntent | null = null;
  let callbackAttempt = 0;

  const notifyCallbackStarted = (url: string | undefined) => {
    if (
      !url ||
      !isPenkraAccountAuthCallbackUrl(url, input.accountAuthScheme)
    )
      return;
    const attempt = ++callbackAttempt;
    const callbackIntent = pendingIntent;
    pendingIntent = null;
    input
      .getWindow()
      ?.webContents.send(DESKTOP_IPC_CHANNELS.accountAuth.callbackStarted, {
        intent: callbackIntent,
      });
    setTimeout(() => {
      if (attempt !== callbackAttempt) return;
      void signInClient
        .getSession()
        .then((result) => {
          if (attempt !== callbackAttempt || result.data?.user) return;
          input
            .getWindow()
            ?.webContents.send(DESKTOP_IPC_CHANNELS.accountAuth.error, {
              message:
                result.error?.message ||
                "Authentication did not complete. Please try again.",
            });
        })
        .catch(() => {
          if (attempt !== callbackAttempt) return;
          input
            .getWindow()
            ?.webContents.send(DESKTOP_IPC_CHANNELS.accountAuth.error, {
              message: "Authentication did not complete. Please try again.",
            });
        });
    }, AUTH_CALLBACK_TIMEOUT_MS);
  };

  app.on("open-url", (_event, url) => {
    notifyCallbackStarted(url);
  });
  app.on(
    "second-instance",
    (_event, commandLine, _workingDirectory, additionalData) => {
      const callbackUrl =
        typeof additionalData === "string" &&
        isPenkraAccountAuthCallbackUrl(
          additionalData,
          input.accountAuthScheme,
        )
          ? additionalData
          : [...commandLine]
              .reverse()
              .find((argument) =>
                isPenkraAccountAuthCallbackUrl(
                  argument,
                  input.accountAuthScheme,
                ),
              );
      notifyCallbackStarted(callbackUrl);
    },
  );
  void app.whenReady().then(() => {
    if (process.platform === "darwin") return;
    notifyCallbackStarted(
      [...process.argv]
        .reverse()
        .find((argument) =>
          isPenkraAccountAuthCallbackUrl(
            argument,
            input.accountAuthScheme,
          ),
        ),
    );
  });

  signInClient.setupMain({
    bridges: false,
    csp: false,
    getWindow: input.getWindow,
    scheme: true,
  });

  input.ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.accountAuth.getState);
  input.ipcMain.handle(
    DESKTOP_IPC_CHANNELS.accountAuth.getState,
    async (event) => {
      if (event.sender !== input.getWindow()?.webContents)
        return authError("Authentication failed.");
      const result = await signInClient.getSession();
      if (result.error) return authError(result.error.message);
      const user = result.data?.user;
      return user
        ? { status: "authenticated", user: toDesktopAccountUser(user) }
        : { status: "unauthenticated" };
    },
  );

  input.ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.accountAuth.requestSignIn);
  input.ipcMain.handle(
    DESKTOP_IPC_CHANNELS.accountAuth.requestSignIn,
    async (event) => {
      if (event.sender !== input.getWindow()?.webContents) return;
      pendingIntent = "sign-in";
      try {
        await signInClient.requestAuth();
      } catch (error) {
        pendingIntent = null;
        throw error;
      }
    },
  );

  input.ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.accountAuth.requestSignUp);
  input.ipcMain.handle(
    DESKTOP_IPC_CHANNELS.accountAuth.requestSignUp,
    async (event) => {
      if (event.sender !== input.getWindow()?.webContents) return;
      pendingIntent = "sign-up";
      try {
        await signUpClient.requestAuth();
      } catch (error) {
        pendingIntent = null;
        throw error;
      }
    },
  );

  input.ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.accountAuth.signOut);
  input.ipcMain.handle(
    DESKTOP_IPC_CHANNELS.accountAuth.signOut,
    async (event) => {
      if (event.sender !== input.getWindow()?.webContents) return;
      await signInClient.signOut();
      input
        .getWindow()
        ?.webContents.send(DESKTOP_IPC_CHANNELS.accountAuth.userUpdated, null);
    },
  );
}

function toDesktopAccountUser(
  user: Record<string, unknown>,
): DesktopAccountUser {
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
