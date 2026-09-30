import {
  ProviderConnectionId,
  ProviderInstallationId,
  ProviderNativeStateGenerationId,
  ThreadId,
} from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { installDiagnosticsStore } from "../../diagnostics/recorder.ts";
import { DiagnosticsStore, openDiagnosticsReader } from "../../diagnostics/store.ts";
import {
  ThreadDiagnosticsQuery,
  type OperationalDiagnostic,
  type ThreadDiagnosticsQueryShape,
} from "../../diagnostics/Services/ThreadDiagnosticsQuery.ts";
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
let currentHarness: "opencode" | "claudeAgent" = "opencode";
let verificationFailure: string | null = null;
let availableClaudeModels = ["claude-sonnet-5", "claude-haiku-4-5"];
let verifiedWithModel: string | undefined;
let discarded = false;
const recordedDiagnostics: OperationalDiagnostic[] = [];

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
  Layer.succeed(ThreadDiagnosticsQuery, {
    recordOperationalDiagnostic: (
      input: Parameters<ThreadDiagnosticsQueryShape["recordOperationalDiagnostic"]>[0],
    ) =>
      Effect.sync(() => {
        recordedDiagnostics.push({
          ...input,
          sequence: recordedDiagnostics.length + 1,
          threadId: input.threadId ?? null,
          code: input.code ?? null,
        });
      }),
  } as never),
  Layer.succeed(ThreadProviderBindingRepository, {
    getHarnessState: () =>
      Effect.succeed(
        Option.some({
          threadId,
          harness: currentHarness,
          nativeStateGenerationId: sourceGenerationId,
          providerSessionId: "native-session",
          nativeStateLocatorJson: JSON.stringify(
            currentHarness === "claudeAgent"
              ? { resume: "native-session" }
              : { openCodeSessionId: "native-session", cwd: "/workspace" },
          ),
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
    discardThreadState: () => Effect.void,
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
        provider: currentHarness,
        listModels: () =>
          Effect.succeed({
            models: availableClaudeModels.map((slug) => ({ slug, name: slug })),
          }),
        verifyNativeResume: (input: { readonly modelSelection?: { readonly model: string } }) =>
          Effect.sync(() => {
            verifiedWithModel = input.modelSelection?.model;
          }).pipe(
            Effect.andThen(
              verificationFailure !== null
                ? Effect.fail(new Error(verificationFailure))
                : Effect.succeed({
                    providerSessionId: returnedIdentity,
                    resumeCursor:
                      currentHarness === "claudeAgent"
                        ? { resume: returnedIdentity }
                        : { openCodeSessionId: returnedIdentity, cwd: "/workspace" },
                  }),
            ),
          ),
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
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-native-verifier-"));
      const store = new DiagnosticsStore({ stateDir, appVersion: "0.14.3", process: "server" });
      const uninstall = installDiagnosticsStore(store);
      returnedIdentity = "native-session";
      discarded = false;
      recordedDiagnostics.length = 0;
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
      assert.deepStrictEqual(
        recordedDiagnostics.map((diagnostic) => diagnostic.code),
        ["NATIVE_CONTINUATION_VERIFICATION_STARTED", "NATIVE_CONTINUATION_VERIFICATION_SUCCEEDED"],
      );
      let db = openDiagnosticsReader(stateDir)!;
      assert.deepStrictEqual(
        db
          .prepare("SELECT step FROM detail ORDER BY id")
          .all()
          .map((row) => row.step),
        [
          "provider.continuation_verification_started",
          "provider.continuation_verification_succeeded",
        ],
      );
      db.close();

      returnedIdentity = "different-session";
      recordedDiagnostics.length = 0;
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
      assert.deepStrictEqual(
        recordedDiagnostics.map((diagnostic) => diagnostic.code),
        ["NATIVE_CONTINUATION_VERIFICATION_STARTED", "NATIVE_CONTINUATION_VERIFICATION_FAILED"],
      );
      assert.strictEqual(recordedDiagnostics[1]?.detail.stage, "validate-resumed-identity");
      db = openDiagnosticsReader(stateDir)!;
      assert.deepStrictEqual(
        db
          .prepare("SELECT step FROM detail ORDER BY id DESC LIMIT 2")
          .all()
          .map((row) => row.step),
        ["provider.continuation_verification_failed", "provider.continuation_verification_started"],
      );
      const incident = db.prepare("SELECT code, context_json FROM incidents").get() as {
        code: string;
        context_json: string;
      };
      assert.strictEqual(incident.code, "APP_OPERATION_FAILED");
      assert.deepStrictEqual(
        { ...JSON.parse(incident.context_json), elapsedMs: 0 },
        { provider: "opencode", verificationStage: "validate-resumed-identity", elapsedMs: 0 },
      );
      db.close();
      for (const name of fs.readdirSync(path.join(stateDir, "diagnostics"))) {
        const file = path.join(stateDir, "diagnostics", name);
        if (fs.statSync(file).isFile())
          assert.strictEqual(fs.readFileSync(file).includes("different-session"), false);
      }
      uninstall();
      store.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }),
  );

  it.effect("reconstructs only a confirmed missing Claude conversation", () =>
    Effect.gen(function* () {
      currentHarness = "claudeAgent";
      returnedIdentity = "native-session";
      const claudeSelection: ResolvedProviderTurnSelection = {
        ...selection,
        harness: "claudeAgent",
        modelId: "claude-sonnet-4-5",
        modelLabel: "Claude Sonnet",
        claudeAccountTransition: {
          source: { authenticationMethodId: "claude-account", providerIdentityId: "alice" },
          target: { authenticationMethodId: "claude-account", providerIdentityId: "bob" },
        },
      };
      try {
        const verifier = yield* ProviderNativeContinuationVerifier;
        verificationFailure = null;
        const exactWithHaiku = yield* verifier.verifySwitch({
          selection: claudeSelection,
          sourceStorage: "connection-profile",
          targetGenerationId,
          runtimeMode: "full-access",
        });
        assert.strictEqual(exactWithHaiku.providerSessionId, "native-session");
        assert.strictEqual(verifiedWithModel, "claude-haiku-4-5");
        assert.strictEqual(claudeSelection.modelId, "claude-sonnet-4-5");
        verificationFailure = "No conversation found with session ID: native-session";
        const reconstructed = yield* verifier.verifySwitch({
          selection: claudeSelection,
          sourceStorage: "connection-profile",
          targetGenerationId,
          runtimeMode: "full-access",
        });
        assert.strictEqual(reconstructed.kind, "reconstructed");
        assert.strictEqual(verifiedWithModel, "claude-haiku-4-5");
        availableClaudeModels = ["claude-sonnet-5"];
        verificationFailure = null;
        const exact = yield* verifier.verifySwitch({
          selection: claudeSelection,
          sourceStorage: "connection-profile",
          targetGenerationId,
          runtimeMode: "full-access",
        });
        assert.strictEqual(exact.providerSessionId, "native-session");
        assert.strictEqual(verifiedWithModel, "claude-sonnet-5");
        assert.strictEqual(claudeSelection.modelId, "claude-sonnet-4-5");
        availableClaudeModels = ["claude-opus-5"];
        const exactWithSelectedModel = yield* verifier.verifySwitch({
          selection: { ...claudeSelection, modelId: "claude-opus-5" },
          sourceStorage: "connection-profile",
          targetGenerationId,
          runtimeMode: "full-access",
        });
        assert.strictEqual(exactWithSelectedModel.providerSessionId, "native-session");
        assert.strictEqual(verifiedWithModel, "claude-opus-5");
        verificationFailure = "Claude authentication failed";
        const authFailure = yield* Effect.exit(
          verifier.verifySwitch({
            selection: claudeSelection,
            sourceStorage: "connection-profile",
            targetGenerationId,
            runtimeMode: "full-access",
          }),
        );
        assert.strictEqual(authFailure._tag, "Failure");
        availableClaudeModels = ["claude-opus-5"];
        verifiedWithModel = undefined;
        const noCheapProbe = yield* Effect.exit(
          verifier.verifySwitch({
            selection: claudeSelection,
            sourceStorage: "connection-profile",
            targetGenerationId,
            runtimeMode: "full-access",
          }),
        );
        assert.strictEqual(noCheapProbe._tag, "Failure");
        assert.strictEqual(verifiedWithModel, undefined);
      } finally {
        currentHarness = "opencode";
        verificationFailure = null;
        availableClaudeModels = ["claude-sonnet-5", "claude-haiku-4-5"];
      }
    }),
  );
});
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
