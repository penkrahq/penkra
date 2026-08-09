// FILE: appSigningAuthorization.ts
// Purpose: Confirms the permanent Sigstore record and opens the trusted publisher login.
// Layer: Desktop App-author security boundary

import { dialog, shell, type BrowserWindow } from "electron";

const DEFAULT_SIGSTORE_ISSUER = "https://oauth2.sigstore.dev/auth";

export async function authorizeAppSigning(input: {
  authorizationUrl: string;
  appId: string;
  version: string;
  packageDigest: string;
  window: BrowserWindow | null;
  issuer?: string;
}): Promise<{ authorized: true }> {
  const target = new URL(input.authorizationUrl);
  const configuredIssuer = new URL(input.issuer?.trim() || DEFAULT_SIGSTORE_ISSUER);
  if (target.protocol !== "https:" || target.origin !== configuredIssuer.origin) {
    throw new Error("The App signing authorization URL is not trusted.");
  }
  const options = {
    type: "warning" as const,
    title: "Sign and publish App",
    message: `Sign ${input.appId} ${input.version}?`,
    detail:
      `Package SHA-256: ${input.packageDigest}\n\n` +
      "Sigstore will permanently record the signing identity and certificate in its public transparency log. Penkra will not store a signing key or refresh token.",
    buttons: ["Cancel", "Continue to sign in"],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  };
  const result = input.window
    ? await dialog.showMessageBox(input.window, options)
    : await dialog.showMessageBox(options);
  if (result.response !== 1) throw new Error("App signing was canceled.");
  await shell.openExternal(target.toString());
  return { authorized: true };
}
