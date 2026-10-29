import * as NodeServices from "@effect/platform-node/NodeServices";
import { DateTime, Duration, Effect, Exit, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { AuthPairingLinkRepository } from "../../persistence/Services/AuthPairingLinks";
import { BootstrapCredentialService } from "../Services/BootstrapCredentialService";
import { BootstrapCredentialServiceLive } from "./BootstrapCredentialService";

const testLayer = BootstrapCredentialServiceLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);

describe("BootstrapCredentialServiceLive", () => {

  it("rejects consumed credentials", async () => {
    await Effect.gen(function* () {
      const service = yield* BootstrapCredentialService;
      const issued = yield* service.issueOneTimeToken();
      yield* service.consume(issued.credential);

      const exit = yield* service.consume(issued.credential).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.runPromise);
  });

  it("revokes active pairing links", async () => {
    await Effect.gen(function* () {
      const service = yield* BootstrapCredentialService;
      const issued = yield* service.issueOneTimeToken();

      expect(yield* service.revoke(issued.id)).toBe(true);
      expect(yield* service.revoke(issued.id)).toBe(false);
      expect(yield* service.listActive()).toEqual([]);
    }).pipe(Effect.provide(testLayer), Effect.runPromise);
  });
});
