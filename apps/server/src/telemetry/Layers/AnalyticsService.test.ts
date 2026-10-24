import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ConfigProvider, Deferred, Effect, Exit, Layer, Scope, Context } from "effect";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { ServerConfig } from "../../config.ts";
import { getTelemetryIdentifier } from "../Identify.ts";
import { AnalyticsService } from "../Services/AnalyticsService.ts";
import { AnalyticsServiceLayerLive } from "./AnalyticsService.ts";

interface RecordedBatchRequest {
  readonly path: string;
  readonly body: {
    readonly batch?: ReadonlyArray<{
      readonly event?: string;
      readonly properties?: {
        readonly index?: number;
        readonly clientType?: string;
      };
    }>;
  } | null;
}

interface RecordedBatchBody {
  readonly batch: ReadonlyArray<{
    readonly event?: string;
    readonly properties?: {
      readonly index?: number;
      readonly clientType?: string;
    };
  }>;
}

it.layer(NodeServices.layer)("AnalyticsService test", (it) => {
  it.effect("twenty records flush immediately and shutdown sends the partial remainder", () =>
    Effect.gen(function* () {
      const requests: RecordedBatchBody[] = [];
      const fullBatch = yield* Deferred.make<void>();
      const serve = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const payload = (yield* request.json) as unknown as RecordedBatchBody;
          requests.push(payload);
          if (payload.batch.length === 20) yield* Deferred.succeed(fullBatch, undefined);
          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const dependencies = Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), { prefix: "penkra-telemetry-events-" }),
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            PENKRA_TELEMETRY_ENABLED: true,
            PENKRA_POSTHOG_KEY: "phc_test_key",
            PENKRA_POSTHOG_HOST: "http://localhost",
            PENKRA_TELEMETRY_FLUSH_BATCH_SIZE: 20,
          }),
        ),
        NodeHttpServer.layerTest,
      );
      yield* Effect.gen(function* () {
        yield* Layer.launch(serve).pipe(Effect.forkScoped);
        // Keep the test server alive while closing the independent analytics scope.
        const scope = yield* Scope.make("sequential");
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const services = yield* Layer.buildWithScope(AnalyticsServiceLayerLive, scope);
        const analytics = Context.get(services, AnalyticsService);
        for (let index = 0; index < 20; index++) yield* analytics.record("threshold", { index });
        yield* Deferred.await(fullBatch);
        assert.equal(requests.length, 1);
        assert.equal(requests[0]?.batch.length, 20);
        for (let index = 20; index < 23; index++) yield* analytics.record("remainder", { index });
        assert.equal(requests.length, 1);
        yield* Scope.close(scope, Exit.void);
        assert.equal(requests.length, 2);
        assert.equal(requests[1]?.batch.length, 3);
      }).pipe(Effect.provide(dependencies));
    }),
  );

  it.effect("flush drains all buffered events across multiple batches", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "penkra-telemetry-base-",
      });

      const telemetryLayer = AnalyticsServiceLayerLive.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          PENKRA_TELEMETRY_ENABLED: true,
          PENKRA_POSTHOG_KEY: "phc_test_key",
          PENKRA_POSTHOG_HOST: "http://localhost",
          PENKRA_TELEMETRY_FLUSH_BATCH_SIZE: 20,
        }),
      );
      const batchServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method !== "POST") {
            return HttpServerResponse.empty({ status: 404 });
          }

          const payload = yield* request.json.pipe(
            Effect.map((body) => body as RecordedBatchRequest["body"]),
            Effect.catch(() => Effect.succeed(null)),
          );

          capturedRequests.push({ path: request.url, body: payload });

          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const telemetryIdentifier = yield* getTelemetryIdentifier;
        assert.equal(telemetryIdentifier !== null, true);
        const analytics = yield* AnalyticsService;

        for (let index = 0; index < 45; index += 1) {
          yield* analytics.record("test.flush.drain", { index });
        }

        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      const batchRequests = capturedRequests.filter(
        (request): request is RecordedBatchRequest & { readonly body: RecordedBatchBody } =>
          Array.isArray(request.body?.batch),
      );
      assert.equal(batchRequests.length, 3);
      assert.equal(
        batchRequests.every(
          (request) => request.path.endsWith("/batch/") || request.path.endsWith("/batch"),
        ),
        true,
      );
      const deliveredIndexes = batchRequests.flatMap((request) =>
        request.body.batch
          .filter((event) => event.event === "test.flush.drain")
          .map((event) => event.properties?.index)
          .filter((index): index is number => typeof index === "number"),
      );

      const sorted = deliveredIndexes.toSorted((a, b) => a - b);
      assert.equal(sorted.length, 45);
      assert.deepEqual(
        sorted,
        Array.from({ length: 45 }, (_, index) => index),
      );
      assert.equal(
        batchRequests.every((request) =>
          request.body.batch.every((event) => event.properties?.clientType === "cli-web-client"),
        ),
        true,
      );
    }),
  );
});
