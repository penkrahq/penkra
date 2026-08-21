import {
  ProviderConnectionId,
  ProviderInstallationId,
  ProviderNativeStateGenerationId,
  ThreadId,
} from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ThreadProviderBindingRepository } from "../../persistence/Services/ThreadProviderBindings.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderLaunchResolver } from "../Services/ProviderLaunchResolver.ts";
import { ProviderNativeContinuationVerifier } from "../Services/ProviderNativeContinuationVerifier.ts";
import { ProviderNativeStateMaterializer } from "../Services/ProviderNativeStateMaterializer.ts";
import type { ResolvedProviderTurnSelection } from "../Services/ProviderTurnSelectionResolver.ts";
import { ProviderNativeContinuationVerifierLive } from "./ProviderNativeContinuationVerifier.ts";

const timestamp = "2026-08-08T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("verify-thread");
const sourceGenerationId = ProviderNativeStateGenerationId.makeUnsafe("verify-source");
const targetGenerationId = ProviderNativeStateGenerationId.makeUnsafe("verify-target");
const connectionId = ProviderConnectionId.makeUnsafe("verify-connection");
const installationId = ProviderInstallationId.makeUnsafe("verify-installation");

let returnedIdentity = "native-session";
let discarded = false;

const selection: ResolvedProviderTurnSelection = {
  threadId,
  harness: "opencode",
  connectionId,
  connectionLabel: "Work",
  previousConnectionId: ProviderConnectionId.makeUnsafe("verify-previous"),
  previousModelId: "opencode-go/kimi-k2.5",
  previousInstallationId: installationId,
  installationId,
  internalProviderId: "opencode-go",
  modelId: "opencode-go/kimi-k2.5",
  modelLabel: "Kimi K2.5",
  stateRevision: 3,
  bindingRevision: 5,
  changed: true,
  requiresNativeStateMaterialization: true,
};

const dependencies = Layer.mergeAll(
  Layer.succeed(ThreadProviderBindingRepository, {
    getHarnessState: () =>
      Effect.succeed(
        Option.some({
          threadId,
          harness: "opencode",
          nativeStateGenerationId: sourceGenerationId,
          providerSessionId: "native-session",
          nativeStateLocatorJson: JSON.stringify({
            openCodeSessionId: "native-session",
            cwd: "/workspace",
          }),
          lastVerifiedResumeAt: timestamp,
          revision: 3,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      ),
  } as never),
  Layer.succeed(ProviderNativeStateMaterializer, {
    clone: () => Effect.succeed("/native/target"),
    discard: () => Effect.sync(() => void (discarded = true)),
    finalize: () => Effect.void,
  }),
  Layer.succeed(ProviderLaunchResolver, {
    resolveProfile: () => Effect.die("not used"),
    resolve: () =>
      Effect.succeed({
        binaryPath: "/managed/opencode",
        isolationKey: "isolated-target",
        profileRoot: "/managed/profile",
        nativeStateRoot: "/managed/native",
        connectionId,
        installationId,
        childEnvironment: () => ({ OPENCODE_AUTH_CONTENT: "selected-only" }),
      }),
  }),
  Layer.succeed(ProviderAdapterRegistry, {
    getByProvider: () =>
      Effect.succeed({
        provider: "opencode",
        verifyNativeResume: () =>
          Effect.succeed({
            providerSessionId: returnedIdentity,
            resumeCursor: {
              openCodeSessionId: returnedIdentity,
              cwd: "/workspace",
            },
          }),
      } as never),
    listProviders: () => Effect.succeed(["opencode"]),
  }),
);
const verifierLayer = ProviderNativeContinuationVerifierLive.pipe(Layer.provide(dependencies));
const layer = it.layer(Layer.mergeAll(dependencies, verifierLayer));

layer("ProviderNativeContinuationVerifier", (it) => {
  it.effect("accepts only the same exact native identity and discards rejected clones", () =>
    Effect.gen(function* () {
      const verifier = yield* ProviderNativeContinuationVerifier;
      returnedIdentity = "native-session";
      discarded = false;
      const verified = yield* verifier.verifySwitch({
        selection,
        sourceStorage: "connection-profile",
        targetGenerationId,
        cwd: "/workspace",
        runtimeMode: "full-access",
      });
      assert.strictEqual(verified.providerSessionId, "native-session");
      assert.strictEqual(verified.generationId, targetGenerationId);
      assert.strictEqual(discarded, false);

      returnedIdentity = "different-session";
      const mismatch = yield* Effect.exit(
        verifier.verifySwitch({
          selection,
          sourceStorage: "connection-profile",
          targetGenerationId,
          cwd: "/workspace",
          runtimeMode: "full-access",
        }),
      );
      assert.strictEqual(mismatch._tag, "Failure");
      assert.strictEqual(discarded, true);
    }),
  );
});
