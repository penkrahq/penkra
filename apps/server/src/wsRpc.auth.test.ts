import { assert, it } from "@effect/vitest";
import { MessageId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vitest";

import { AuthError } from "./auth/Services/ServerAuth";
import { authenticateRpcWebSocketUpgrade, isPairedPhoneSession, isRendererToken } from "./wsRpc";
import { originForWsConnection } from "./wsConnectionSessions";
import * as NodeSqliteClient from "./persistence/NodeSqliteClient";
import { runMigrations } from "./persistence/Migrations";
import { seedThreadFolderFixture } from "./cleanCore/threadFixtures";
import { createThread } from "./cleanCore/threadStore";
import { enqueueMessage, readThreadQueue } from "./cleanCore/threadQueue";

it.effect("renderer and external attribution survive queue persistence", () =>
  Effect.gen(function* () {
    assert.isTrue(isRendererToken("renderer-secret", "renderer-secret"));
    assert.isFalse(isRendererToken("legacy-secret", "renderer-secret"));
    yield* runMigrations();
    yield* seedThreadFolderFixture("core-test-folder", "space-1");
    yield* createThread({
      id: "thread-1",
      spaceId: "space-1",
      folderId: "core-test-folder",
      title: "Test",
      provider: "codex",
      model: "test",
      runtimeMode: "full-access",
      createdBy: "user",
      createdAt: "2026-10-09T00:00:00.000Z",
    });
    for (const [index, kind] of (["renderer", "phone", "external"] as const).entries()) {
      yield* enqueueMessage("thread-1", {
        messageId: MessageId.make(`m${index}`),
        attachments: [],
        origin: originForWsConnection(kind),
        text: kind,
        queuedAt: "2026-10-09T00:00:01.000Z",
      });
    }
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO auth_sessions (session_id, subject, role, method, issued_at, expires_at) VALUES ('phone-session', 'phone-1', 'client', 'bearer-session-token', '2026-10-09', '2027-10-09')`;
    yield* sql`INSERT INTO remote_devices (scope_key, device_id, name, identity_key, session_id, paired_at, pending_backend) VALUES ('scope', 'phone-1', 'Phone', zeroblob(32), 'phone-session', '2026-10-09', 0)`;
    assert.isTrue(yield* isPairedPhoneSession("phone-session", "phone-1"));
    assert.isFalse(yield* isPairedPhoneSession("phone-session", "another-device"));
    assert.isFalse(yield* isPairedPhoneSession("other-session", "phone-1"));
    const queue = yield* readThreadQueue("thread-1");
    assert.deepStrictEqual(
      queue.map((message) => message.origin),
      [{ _tag: "user" }, { _tag: "user" }, { _tag: "external", client: "Terminal" }],
    );
    const rows = yield* sql<{ queue: string }>`SELECT queue FROM threads WHERE id = 'thread-1'`;
    assert.deepStrictEqual(
      JSON.parse(rows[0]!.queue).map((message: { origin: unknown }) => message.origin),
      queue.map((message) => message.origin),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("does not accept a legacy query token on a non-loopback bind", () =>
  Effect.gen(function* () {
    const authenticateWebSocketUpgrade = vi.fn(() =>
      Effect.fail(
        new AuthError({
          message: "Authentication required.",
          status: 401,
        }),
      ),
    );

    const error = yield* authenticateRpcWebSocketUpgrade({
      config: { host: "192.168.1.50", authToken: "remote-secret", publicUrl: undefined },
      legacyToken: "remote-secret",
      request: {
        headers: {},
        cookies: {},
        url: new URL("http://192.168.1.50:3773/ws?token=remote-secret"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    }).pipe(Effect.flip);

    assert.equal(error.status, 401);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 1);
  }),
);

it.effect(
  "disables the legacy loopback query token when an HTTPS public origin is configured",
  () =>
    Effect.gen(function* () {
      const authenticatedSession = {
        sessionId: "proxy-session" as never,
        subject: "owner-bootstrap",
        method: "browser-session-cookie" as const,
        role: "owner" as const,
      };
      const authenticateWebSocketUpgrade = vi.fn(() => Effect.succeed(authenticatedSession));

      const session = yield* authenticateRpcWebSocketUpgrade({
        config: {
          host: "127.0.0.1",
          authToken: "proxy-secret",
          publicUrl: new URL("https://penkra.example.test/"),
        },
        legacyToken: "proxy-secret",
        request: {
          headers: {},
          cookies: { "penkra-session": "paired-session-credential" },
          url: new URL("http://127.0.0.1:3773/ws?token=proxy-secret"),
        },
        serverAuth: { authenticateWebSocketUpgrade },
      });

      assert.equal(session, authenticatedSession);
      assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 1);
    }),
);
