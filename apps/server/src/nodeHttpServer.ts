import http from "node:http";
import type { ListenOptions } from "node:net";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Scope } from "effect";
import * as HttpServer from "effect/unstable/http/HttpServer";
import { ServeError } from "effect/unstable/http/HttpServerError";
import { WebSocketServer } from "ws";
import { recordServerQaActionAsync, serverQaProofConfig } from "./diagnostics/qaProofBuild";
import { verifyQaSocketClient } from "@penkra/shared/diagnostics/qaSocketTicket";
import { QaSocketReconnectTracker } from "./diagnostics/qaSocketReconnect";

export const MAX_WEBSOCKET_MESSAGE_BYTES = 2 * 1024 * 1024;

/** Effect's upgrade handler calls handleUpgrade but does not emit ws's connection event. */
export function emitConnectionAfterUpgrade(server: WebSocketServer): void {
  const handleUpgrade = server.handleUpgrade.bind(server);
  server.handleUpgrade = (request, socket, head, callback) =>
    handleUpgrade(request, socket, head, (ws, upgradedRequest) => {
      try {
        server.emit("connection", ws, upgradedRequest);
      } catch {
        // An observer must never prevent Effect from receiving the upgraded socket.
      }
      callback(ws, upgradedRequest);
    });
}

/**
 * Owns the Node HTTP/WebSocket transport so Penkra, rather than the platform
 * adapter's 100 MiB default, controls admission before a message is decoded.
 */
export const makeBoundedNodeHttpServer = Effect.fnUntraced(function* (
  evaluate: () => http.Server,
  options: ListenOptions,
) {
  const scope = yield* Effect.scope;
  const server = evaluate();

  yield* Scope.addFinalizer(
    scope,
    Effect.callback<void>((resume) => {
      if (!server.listening) {
        resume(Effect.void);
        return;
      }
      server.close((error) => {
        if (error) resume(Effect.die(error));
        else resume(Effect.void);
      });
    }),
  );

  yield* Effect.callback<void, ServeError>((resume) => {
    const onError = (cause: Error) => resume(Effect.fail(new ServeError({ cause })));
    server.on("error", onError);
    server.listen(options, () => {
      server.off("error", onError);
      resume(Effect.void);
    });
  });

  const address = server.address()!;
  const webSocketServer = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const webSocketServer = new WebSocketServer({
        noServer: true,
        maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
        perMessageDeflate: false,
      });
      emitConnectionAfterUpgrade(webSocketServer);
      return webSocketServer;
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resume(Effect.void));
      }),
  ).pipe(Scope.provide(scope));

  const bootstrapUpgrades = new WeakMap<
    http.IncomingMessage,
    {
      startedAt: number;
      timer: NodeJS.Timeout;
      onSocketClose: () => void;
    }
  >();
  const qaReconnects = new QaSocketReconnectTracker(
    (traceId) => {
      void recordServerQaActionAsync("reconnect", traceId).catch(() =>
        process.stderr.write("[diagnostics] QA reconnect action proof failed\n"),
      );
    },
    (clientId, ticketId, signature) => {
      try {
        const config = serverQaProofConfig();
        return config !== null && verifyQaSocketClient(config, clientId, ticketId, signature);
      } catch {
        return false;
      }
    },
  );

  webSocketServer.on("connection", (socket, request) => {
    const bootstrapUpgrade = bootstrapUpgrades.get(request);
    if (bootstrapUpgrade) {
      clearTimeout(bootstrapUpgrade.timer);
      request.socket.off("close", bootstrapUpgrade.onSocketClose);
      bootstrapUpgrades.delete(request);
      const durationMs = Math.round(performance.now() - bootstrapUpgrade.startedAt);
      if (durationMs >= 2_000) {
        console.warn("[server-transport] bootstrap WebSocket upgrade slow", { durationMs });
      }
    }
    const openedAtMs = Date.now();
    const requestPath = (() => {
      try {
        return new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      } catch {
        return "unknown";
      }
    })();
    let qaConnection = {
      closed: () => {},
      receivedFrame: (_raw: string) => {},
      sentFrame: (_raw: string) => {},
    };
    if (requestPath === "/ws") {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        qaConnection = qaReconnects.opened({
          clientId: url.searchParams.get("qaClientId"),
          ticketId: url.searchParams.get("qaTicketId"),
          signature: url.searchParams.get("qaClientSignature"),
          traceId: url.searchParams.get("qaReconnectTraceId"),
        });
      } catch {
        // Invalid optional QA parameters cannot affect the WebSocket.
      }
    }
    const originalSend = socket.send;
    Object.defineProperty(socket, "send", {
      value: (...args: unknown[]) => {
        const data = args[0];
        try {
          if (typeof data === "string") qaConnection.sentFrame(data);
          else if (Buffer.isBuffer(data)) qaConnection.sentFrame(data.toString("utf8"));
        } catch {
          // QA observation must not change the server's response delivery.
        }
        return Reflect.apply(originalSend, socket, args);
      },
    });
    socket.on("message", (data) => {
      try {
        qaConnection.receivedFrame(data.toString("utf8"));
      } catch {
        // QA observation must not change request handling.
      }
    });
    let terminalLogged = false;
    socket.once("close", (code, reason) => {
      try {
        qaConnection.closed();
        if (terminalLogged) return;
        terminalLogged = true;
        Effect.runFork(
          Effect.logInfo("WebSocket connection closed").pipe(
            Effect.annotateLogs({
              requestPath,
              code,
              reason: reason.toString("utf8") || null,
              durationMs: Math.max(0, Date.now() - openedAtMs),
            }),
          ),
        );
      } catch {
        // Observation cannot affect socket shutdown.
      }
    });
    socket.once("error", (error) => {
      if (terminalLogged) return;
      terminalLogged = true;
      try {
        Effect.runFork(
          Effect.logWarning("WebSocket connection error").pipe(
            Effect.annotateLogs({ requestPath, error: error.message }),
          ),
        );
      } catch {
        // Observation cannot affect socket error handling.
      }
    });
  });

  return HttpServer.make({
    address:
      typeof address === "string"
        ? { _tag: "UnixAddress", path: address }
        : {
            _tag: "TcpAddress",
            hostname: address.address === "::" ? "0.0.0.0" : address.address,
            port: address.port,
          },
    serve: Effect.fnUntraced(function* (httpApp, middleware) {
      const serveScope = yield* Effect.scope;
      const handler = yield* NodeHttpServer.makeHandler(httpApp, {
        middleware: middleware as any,
        scope: serveScope,
      }) as Effect.Effect<
        (nodeRequest: http.IncomingMessage, nodeResponse: http.ServerResponse) => void
      >;
      const upgradeHandler = yield* NodeHttpServer.makeUpgradeHandler(
        Effect.succeed(webSocketServer),
        httpApp,
        {
          middleware: middleware as any,
          scope: serveScope,
        },
      );
      const observeHealthRequest = (
        request: http.IncomingMessage,
        response: http.ServerResponse,
      ) => {
        if (request.url !== "/health") return;
        const startedAt = performance.now();
        const timer = setTimeout(() => {
          console.warn("[server-transport] health request still in flight", {
            elapsedMs: Math.round(performance.now() - startedAt),
          });
        }, 3_500);
        timer.unref();
        const finish = () => {
          clearTimeout(timer);
          const durationMs = Math.round(performance.now() - startedAt);
          if (durationMs >= 2_000) {
            console.warn("[server-transport] health response slow", { durationMs });
          }
        };
        response.once("finish", finish);
        response.once("close", () => clearTimeout(timer));
      };
      const observeBootstrapUpgrade = (request: http.IncomingMessage) => {
        if (request.url?.split("?", 1)[0] !== "/ws/bootstrap") return;
        const startedAt = performance.now();
        const timer = setTimeout(() => {
          console.warn("[server-transport] bootstrap WebSocket upgrade still in flight", {
            elapsedMs: Math.round(performance.now() - startedAt),
          });
        }, 3_500);
        timer.unref();
        const onSocketClose = () => {
          clearTimeout(timer);
          bootstrapUpgrades.delete(request);
        };
        bootstrapUpgrades.set(request, { startedAt, timer, onSocketClose });
        request.socket.once("close", onSocketClose);
      };

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          server.off("request", observeHealthRequest);
          server.off("upgrade", observeBootstrapUpgrade);
          server.off("request", handler);
          server.off("upgrade", upgradeHandler);
        }),
      );
      server.on("request", observeHealthRequest);
      server.on("upgrade", observeBootstrapUpgrade);
      server.on("request", handler);
      server.on("upgrade", upgradeHandler);
    }),
  });
});
