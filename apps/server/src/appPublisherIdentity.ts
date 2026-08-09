// FILE: appPublisherIdentity.ts
// Purpose: Obtains one short-lived Sigstore identity token through browser OIDC + localhost PKCE.
// Layer: Registered App developer lifecycle

import * as Http from "node:http";

import * as Oidc from "openid-client";

import type { AppDeveloperBridge } from "./appDeveloperLifecycle";

const DEFAULT_CLIENT_ID = "sigstore";
const CALLBACK_PATH = "/auth/callback";
const AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;

export async function getPublisherIdentityToken(input: {
  issuer: string;
  bridge: AppDeveloperBridge;
  appId: string;
  version: string;
  packageDigest: string;
}): Promise<string> {
  const issuer = requireHttpsUrl(input.issuer, "Sigstore OIDC issuer");
  const callback = await createLoopbackCallback();
  try {
    const redirectUri = `http://127.0.0.1:${callback.port}${CALLBACK_PATH}`;
    const config = await Oidc.discovery(
      issuer,
      DEFAULT_CLIENT_ID,
      { redirect_uris: [redirectUri], response_types: ["code"] },
      Oidc.None(),
    );
    const codeVerifier = Oidc.randomPKCECodeVerifier();
    const state = Oidc.randomState();
    const nonce = Oidc.randomNonce();
    const authorizationUrl = Oidc.buildAuthorizationUrl(config, {
      access_type: "online",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email",
      code_challenge: await Oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });

    await input.bridge("developer.signing.authorize", {
      authorizationUrl: authorizationUrl.toString(),
      appId: input.appId,
      version: input.version,
      packageDigest: input.packageDigest,
    });
    const callbackUrl = await callback.result;
    const tokens = await Oidc.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedState: state,
      expectedNonce: nonce,
    });
    if (!tokens.id_token)
      throw new Error("The Sigstore identity provider did not return an ID token.");
    return tokens.id_token;
  } finally {
    await callback.close();
  }
}

async function createLoopbackCallback(): Promise<{
  port: number;
  result: Promise<URL>;
  close(): Promise<void>;
}> {
  let resolveResult!: (url: URL) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<URL>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let settled = false;
  const server = Http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || requestUrl.pathname !== CALLBACK_PATH) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
    });
    response.end(
      "<!doctype html><meta charset=utf-8><title>Penkra signing complete</title>" +
        "<style>body{font:16px system-ui;margin:3rem;max-width:42rem}h1{font-size:1.4rem}</style>" +
        "<h1>Return to Penkra</h1><p>The identity step is complete. You may close this tab.</p>",
    );
    if (!settled) {
      settled = true;
      resolveResult(new URL(requestUrl.pathname + requestUrl.search, `http://127.0.0.1:${port}`));
    }
  });
  server.on("error", (error) => {
    if (settled) return;
    settled = true;
    rejectResult(error);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Unable to open the signing callback.");
  const port = address.port;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectResult(new Error("Sigstore browser authorization timed out."));
  }, AUTHORIZATION_TIMEOUT_MS);

  return {
    port,
    result,
    close: async () => {
      clearTimeout(timer);
      if (!server.listening) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function requireHttpsUrl(value: string, label: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS.`);
  return url;
}
