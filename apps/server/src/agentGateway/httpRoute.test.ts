import http from "node:http";
import { makeAgentGatewaySessionRegistry } from "./Layers/AgentGatewaySessionRegistry.ts";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@penkra/contracts";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { AgentGateway, type AgentGatewayShape } from "./Services/AgentGateway.ts";
import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "./Services/AgentGatewayCredentials.ts";
import {
  AGENT_GATEWAY_MCP_MAX_BODY_BYTES,
  AGENT_GATEWAY_ORIGIN_TURN_HEADER,
  AGENT_GATEWAY_NATIVE_SESSION_HEADER,
  agentGatewayRouteLayer,
} from "./httpRoute.ts";

import type { AgentGatewayWriteAuthority } from "./Services/AgentGatewaySessionRegistry.ts";

const VALID_TOKEN = "sagw_session_http_route_test";

async function withGatewayServer(
  run: (input: {
    readonly origin: string;
    readonly handledBodies: ReadonlyArray<unknown>;
    readonly handledOrigins: ReadonlyArray<string | undefined>;
    readonly handledAuthorities: ReadonlyArray<AgentGatewayWriteAuthority | null | undefined>;
    readonly setActiveTurn: (turnId: string | null) => void;
    readonly onNextBinding: () => Promise<void>;
    readonly processToken: string;
    readonly foreignProcessToken: string;
    readonly handledAuthorizations: ReadonlyArray<string | undefined>;
    readonly revokeProcess: () => void;
  }) => Promise<void>,
): Promise<void> {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  const handledBodies: unknown[] = [];
  const handledAuthorizations: Array<string | undefined> = [];
  const handledOrigins: Array<string | undefined> = [];
  const handledAuthorities: Array<AgentGatewayWriteAuthority | null | undefined> = [];
  let activeTurnId: string | null = "turn-http-old";
  let bindingObserved: (() => void) | undefined;
  let nodeServer: http.Server | null = null;
  try {
    const threadId = ThreadId.makeUnsafe("thread-http-route-test");
    let sequence = 0;
    const registry = makeAgentGatewaySessionRegistry({
      randomId: () => (++sequence === 2 ? "http_route_test" : `http-route-${sequence}`),
    });
    registry.issue(threadId, "opencode");
    const processToken = registry.processes.issue("opencode");
    const foreignProcessToken = registry.processes.issue("opencode");
    registry.processes.register(processToken, "native-http-session", VALID_TOKEN);
    registry.processes.registerProbe(processToken, "native-http-probe");
    const credentials: AgentGatewayCredentialsShape = {
      mcpEndpointUrl: "http://127.0.0.1/mcp",
      processes: registry.processes,
      setListeningPort: () => undefined,
      issueSessionToken: () => VALID_TOKEN,
      verifySessionToken: (token) => (token === VALID_TOKEN ? threadId : null),
      verifySession: (token) =>
        token === VALID_TOKEN
          ? {
              sessionKey: "session-http-route-test",
              threadId,
              provider: "opencode",
              issuedAt: 1,
              activeTurnId,
              capabilities: new Set(["thread:read", "thread:write"]),
            }
          : null,
      bindWriteAuthority: () => {
        const authority =
          activeTurnId === null
            ? null
            : {
                sessionKey: "session-http-route-test",
                threadId,
                provider: "opencode" as const,
                turnId: activeTurnId,
              };
        bindingObserved?.();
        bindingObserved = undefined;
        return authority;
      },
      beginTurn: () => undefined,
      endTurn: () => undefined,
      endSession: () => undefined,
      verifyWriteAuthority: () => false,
      revokeSessionToken: () => undefined,
      connectionForThread: () => ({
        url: "http://127.0.0.1/mcp",
        bearerToken: VALID_TOKEN,
      }),
      stdioProxy: { command: process.execPath, args: [] },
    };
    const gateway: AgentGatewayShape = {
      toolDefinitions: [],
      invokeTool: () => Effect.die("Direct tool invocation is not used by this test."),
      handleMcpPost: (input) => {
        handledAuthorizations.push(input.authorizationHeader);
        handledBodies.push(input.body);
        handledOrigins.push(input.originTurnId);
        handledAuthorities.push(input.ingressWriteAuthority?.authority);
        return Effect.succeed({ status: 200, body: { ok: true } });
      },
    };

    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const httpServer = yield* NodeHttpServer.make(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { port: 0, host: "127.0.0.1" },
          );
          const httpApp = yield* HttpRouter.toHttpEffect(agentGatewayRouteLayer);
          yield* httpServer.serve(httpApp);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(AgentGateway, gateway),
              Layer.succeed(AgentGatewayCredentials, credentials),
              NodeServices.layer,
            ),
          ),
        ),
        scope,
      ),
    );

    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object") {
      throw new Error("Expected agent gateway test server to expose an address");
    }
    await run({
      processToken,
      foreignProcessToken,
      handledAuthorizations,
      revokeProcess: () => registry.processes.revoke(processToken),
      origin: `http://127.0.0.1:${address.port}`,
      handledBodies,
      handledOrigins,
      handledAuthorities,
      setActiveTurn: (turnId) => {
        activeTurnId = turnId;
      },
      onNextBinding: () =>
        new Promise<void>((resolve) => {
          bindingObserved = resolve;
        }),
    });
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

describe("agentGatewayRouteLayer", () => {
  it("allows registered tools-disabled probes to initialize without granting any thread authority", async () => {
    await withGatewayServer(async ({ origin, processToken, handledBodies }) => {
      const send = (method: string) =>
        fetch(`${origin}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${processToken}`,
            [AGENT_GATEWAY_NATIVE_SESSION_HEADER]: "native-http-probe",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
        });
      const initialized = await send("initialize");
      expect(initialized.status).toBe(200);
      expect(
        ((await initialized.json()) as { result: { instructions: string } }).result.instructions,
      ).toBe("");
      expect((await send("tools/call")).status).toBe(401);
      expect((await send("tools/list")).status).toBe(401);
      expect(handledBodies).toEqual([]);
    });
  });
  it("resolves a registered native session before binding ingress authority and rejects other process scopes", async () => {
    await withGatewayServer(
      async ({
        origin,
        processToken,
        foreignProcessToken,
        handledAuthorizations,
        revokeProcess,
      }) => {
        const send = (token: string, nativeSessionId?: string) =>
          fetch(`${origin}/mcp`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              ...(nativeSessionId === undefined
                ? {}
                : { [AGENT_GATEWAY_NATIVE_SESSION_HEADER]: nativeSessionId }),
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
          });
        expect((await send(processToken, "native-http-session")).status).toBe(200);
        expect(handledAuthorizations).toEqual([`Bearer ${VALID_TOKEN}`]);
        expect((await send(foreignProcessToken, "native-http-session")).status).toBe(401);
        expect((await send(processToken, "unregistered")).status).toBe(401);
        expect((await send(processToken)).status).toBe(401);
        expect((await send(VALID_TOKEN, "native-http-session")).status).toBe(401);
        revokeProcess();
        expect((await send(processToken, "native-http-session")).status).toBe(401);
        expect(handledAuthorizations).toHaveLength(1);
      },
    );
  });
  it("authenticates before reading the body and enforces the 1 MiB limit", async () => {
    await withGatewayServer(async ({ origin, handledBodies, handledOrigins }) => {
      const oversizedBody = "x".repeat(AGENT_GATEWAY_MCP_MAX_BODY_BYTES + 1);
      const unauthorized = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: { Authorization: "Bearer invalid" },
        body: oversizedBody,
      });
      expect(unauthorized.status).toBe(401);

      const oversized = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: oversizedBody,
      });
      expect(oversized.status).toBe(413);
      expect(handledBodies).toHaveLength(0);

      const validBody = { jsonrpc: "2.0", id: 1, method: "ping" };
      const valid = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VALID_TOKEN}`,
          "Content-Type": "application/json",
          [AGENT_GATEWAY_ORIGIN_TURN_HEADER]: "turn-http-origin",
        },
        body: JSON.stringify(validBody),
      });
      expect(valid.status).toBe(200);
      expect(await valid.json()).toEqual({ ok: true });
      expect(handledOrigins).toEqual(["turn-http-origin"]);
      expect(handledBodies).toEqual([validBody]);
    });
  });

  it.each(["turn-http-old", null])(
    "captures authority %s before a delayed HTTP body",
    async (arrivedTurn) => {
      await withGatewayServer(
        async ({ origin, handledAuthorities, setActiveTurn, onNextBinding }) => {
          setActiveTurn(arrivedTurn);
          const bound = onNextBinding();
          const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" });
          let request!: http.ClientRequest;
          const completed = new Promise<void>((resolve, reject) => {
            request = http.request(
              `${origin}/mcp`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${VALID_TOKEN}`,
                  "Content-Length": Buffer.byteLength(body),
                },
              },
              (response) => {
                response.resume();
                response.on("end", resolve);
              },
            );
            request.on("error", reject);
            request.flushHeaders();
          });
          await bound;
          setActiveTurn("turn-http-new");
          request.end(body);
          await completed;
          expect(handledAuthorities).toHaveLength(1);
          expect(handledAuthorities[0]?.turnId ?? null).toBe(arrivedTurn);
        },
      );
    },
  );

  it("returns 400 for malformed authenticated JSON", async () => {
    await withGatewayServer(async ({ origin, handledBodies }) => {
      const response = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: "{not-json",
      });
      expect(response.status).toBe(400);
      expect(handledBodies).toHaveLength(0);
    });
  });
});
