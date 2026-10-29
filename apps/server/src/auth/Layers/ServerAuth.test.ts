import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { AuthControlPlaneLive } from "./AuthControlPlane";
import { BootstrapCredentialServiceLive } from "./BootstrapCredentialService";
import { ServerAuthLive } from "./ServerAuth";
import { ServerAuthPolicyLive } from "./ServerAuthPolicy";
import { ServerSecretStoreLive } from "./ServerSecretStore";
import { SessionCredentialServiceLive } from "./SessionCredentialService";
import { AuthError, ServerAuth, type AuthRequest } from "../Services/ServerAuth";
import { authenticateRpcWebSocketUpgrade } from "../../wsRpc";

const sessionCredentialLayer = SessionCredentialServiceLive.pipe(
  Layer.provide(ServerSecretStoreLive),
);
const authControlPlaneLayer = AuthControlPlaneLive.pipe(
  Layer.provide(BootstrapCredentialServiceLive),
  Layer.provide(sessionCredentialLayer),
);
const testLayer = ServerAuthLive.pipe(
  Layer.provide(ServerAuthPolicyLive),
  Layer.provide(BootstrapCredentialServiceLive),
  Layer.provide(sessionCredentialLayer),
  Layer.provide(authControlPlaneLayer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStoreLive),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "penkra-auth-server-test-",
    }),
  ),
  Layer.provide(NodeServices.layer),
);

const requestMetadata = {
  deviceType: "desktop" as const,
  os: "macOS",
  browser: "Chrome",
  ipAddress: "192.168.1.23",
};

function makeCookieRequest(sessionToken: string): AuthRequest {
  return {
    headers: {},
    cookies: {
      penkra_session: sessionToken,
    },
  };
}

const runServerAuthTest = (effect: Effect.Effect<void, AuthError, ServerAuth>) =>
  effect.pipe(Effect.provide(testLayer), Effect.scoped, Effect.runPromise);

describe("ServerAuthLive", () => {
  it("logs out the current session, invalidates its websocket ticket, and preserves others", async () => {
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;
        const currentCredential = yield* serverAuth.issuePairingCredential();
        const currentExchange = yield* serverAuth.exchangeBootstrapCredential(
          currentCredential.credential,
          requestMetadata,
        );
        const currentSession = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(currentExchange.sessionToken),
        );
        const websocketToken = yield* serverAuth.issueWebSocketToken(currentSession);

        const otherCredential = yield* serverAuth.issuePairingCredential();
        const otherExchange = yield* serverAuth.exchangeBootstrapCredential(
          otherCredential.credential,
          requestMetadata,
        );

        expect(yield* serverAuth.logoutSession(currentSession.sessionId)).toBe(true);
        expect(
          (yield* Effect.flip(
            serverAuth.authenticateHttpRequest(makeCookieRequest(currentExchange.sessionToken)),
          ).pipe(Effect.orDie)).status,
        ).toBe(401);
        expect(
          (yield* Effect.flip(
            serverAuth.authenticateWebSocketUpgrade({
              headers: {},
              cookies: {},
              url: new URL(`ws://127.0.0.1:3773/?wsToken=${websocketToken.token}`),
            }),
          ).pipe(Effect.orDie)).status,
        ).toBe(401);
        expect(
          (yield* serverAuth.authenticateHttpRequest(makeCookieRequest(otherExchange.sessionToken)))
            .credentialSource,
        ).toBe("cookie");
      }),
    );
  });

  it("bootstraps a remote owner session without accepting the legacy websocket token", async () => {
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;
        const config = {
          host: "0.0.0.0",
          authToken: "remote-startup-secret",
          publicUrl: undefined,
        } as const;

        const legacyError = yield* authenticateRpcWebSocketUpgrade({
          config,
          legacyToken: "remote-startup-secret",
          request: {
            headers: {},
            cookies: {},
            url: new URL("ws://192.168.1.50:3773/ws?token=remote-startup-secret"),
          },
          serverAuth,
        }).pipe(Effect.flip, Effect.orDie);
        expect(legacyError.status).toBe(401);

        const pairingUrl = yield* serverAuth.issueStartupPairingUrl("http://192.168.1.50:3773");
        const bootstrapToken =
          new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get("token") ?? "";
        const exchanged = yield* serverAuth.exchangeBootstrapCredential(
          bootstrapToken,
          requestMetadata,
        );
        const upgraded = yield* authenticateRpcWebSocketUpgrade({
          config,
          legacyToken: "remote-startup-secret",
          request: {
            ...makeCookieRequest(exchanged.sessionToken),
            url: new URL("ws://192.168.1.50:3773/ws?token=remote-startup-secret"),
          },
          serverAuth,
        });

        expect(upgraded?.role).toBe("owner");
        expect(upgraded?.subject).toBe("owner-bootstrap");
      }),
    );
  });
});
