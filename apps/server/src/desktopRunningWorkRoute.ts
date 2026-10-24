import { Option } from "effect";
// Private, window-independent working-thread truth for native power and cursor lifetime.
import { Effect, Stream } from "effect";
import type { DesktopRunningWorkState, ThreadId } from "@penkra/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { ServerConfig } from "./config";
import { authorizeDesktopShutdown } from "./serverShutdown";
import { ThreadPublisher } from "./cleanCore/ThreadPublisher.ts";
import type { ThreadPublisher as ThreadPublisherValue } from "./cleanCore/threadStore.ts";

export const makeRunningWorkStream = (publisher: ThreadPublisherValue) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The empty key is an initial invalidation only, never a thread lookup or a
    // published change. Hub registration precedes this first database read.
    return publisher.threadChanges.stream(undefined, { threadId: "" }).pipe(
      Stream.mapEffect(
        () => sql<{ id: ThreadId }>`SELECT t.id FROM threads t
      WHERE t.state='running' AND t.deleted_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM thread_items q WHERE q.thread_id=t.id AND q.kind='question' AND q.status='open'
      ) ORDER BY t.id`,
      ),
      Stream.map(
        (rows) => ({ working: rows.map((row) => row.id) }) satisfies DesktopRunningWorkState,
      ),
      Stream.changesWith(
        (a, b) =>
          a.working.length === b.working.length &&
          a.working.every((id, index) => id === b.working[index]),
      ),
    );
  });

export const desktopRunningWorkRouteLayer = HttpRouter.add(
  "GET",
  "/api/desktop/running-work",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const auth = authorizeDesktopShutdown({
      config,
      remoteAddress: Option.getOrUndefined(request.remoteAddress),
      authorization: request.headers.authorization,
    });
    if (!auth.authorized)
      return HttpServerResponse.jsonUnsafe({ message: auth.reason }, { status: auth.status });
    const publisher = yield* ThreadPublisher;
    const stream = yield* makeRunningWorkStream(publisher);
    return HttpServerResponse.stream(
      stream.pipe(
        Stream.map((state) => JSON.stringify(state) + "\n"),
        Stream.encodeText,
      ),
      {
        contentType: "application/x-ndjson",
        headers: { "Cache-Control": "no-store" },
      },
    );
  }),
);
