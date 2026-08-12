import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderConnectionId, ProviderInstallationId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ServerConfig } from "../../config.ts";
import { ProviderConnectionLoginRepositoryLive } from "../../persistence/Layers/ProviderConnectionLogins.ts";
import { ProviderConnectionRepositoryLive } from "../../persistence/Layers/ProviderConnections.ts";
import { ProviderInstallationRepositoryLive } from "../../persistence/Layers/ProviderInstallations.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { ProviderConnectionLoginRepository } from "../../persistence/Services/ProviderConnectionLogins.ts";
import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";
import { ProviderInstallationRepository } from "../../persistence/Services/ProviderInstallations.ts";
import type {
  CodexManagedAccountSnapshot,
  CodexManagedLoginHandle,
} from "../codexManagedAccountLogin.ts";
import type {
  CodexManagedApiKeyImportHandle,
  CodexManagedApiKeySnapshot,
} from "../codexManagedApiKeyLogin.ts";
import {
  ProviderCredentialBroker,
  ProviderCredentialBrokerError,
} from "../providerCredentialBroker.ts";
import { ProviderConnectionLoginCoordinator } from "../Services/ProviderConnectionLoginCoordinator.ts";
import { makeProviderConnectionLoginCoordinator } from "./ProviderConnectionLoginCoordinator.ts";

const timestamp = "2026-08-08T00:00:00.000Z";
let id = 0;
let pendingLogin:
  | {
      readonly handle: CodexManagedLoginHandle;
      readonly resolve: (account: CodexManagedAccountSnapshot) => void;
    }
  | undefined;
let pendingApiKeyImport:
  | {
      readonly handle: CodexManagedApiKeyImportHandle;
      readonly resolve: (account: CodexManagedApiKeySnapshot) => void;
    }
  | undefined;
let importedApiKey: string | null = null;
let probedAccount: CodexManagedAccountSnapshot | null = null;
let probeFailure: Error | null = null;
let logoutCount = 0;
let logoutFailure: Error | null = null;
let startFailure: Error | null = null;
let claimFailure: string | null = null;
const credentialClaims: Array<{ secret: string; reference: string }> = [];
const releasedCredentialClaims: string[] = [];

const startLogin = async (): Promise<CodexManagedLoginHandle> => {
  if (startFailure !== null) throw startFailure;
  let resolve!: (account: CodexManagedAccountSnapshot) => void;
  const completion = new Promise<CodexManagedAccountSnapshot>((complete) => {
    resolve = complete;
  });
  const handle: CodexManagedLoginHandle = {
    loginId: `login-${id}`,
    authUrl: "https://auth.example/login",
    completion,
    cancel: async () => undefined,
  };
  pendingLogin = { handle, resolve };
  return handle;
};

const startApiKeyImport = (input: { readonly secret: string }): CodexManagedApiKeyImportHandle => {
  importedApiKey = input.secret;
  let resolve!: (account: CodexManagedApiKeySnapshot) => void;
  const completion = new Promise<CodexManagedApiKeySnapshot>((complete) => {
    resolve = complete;
  });
  const handle: CodexManagedApiKeyImportHandle = {
    completion,
    cancel: async () => undefined,
  };
  pendingApiKeyImport = { handle, resolve };
  return handle;
};

const sqlLayer = NodeSqliteClient.layerMemory();
const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "penkra-connection-login-test-",
}).pipe(Layer.provide(NodeServices.layer));
const repositories = Layer.mergeAll(
  ProviderConnectionLoginRepositoryLive.pipe(Layer.provide(sqlLayer)),
  ProviderConnectionRepositoryLive.pipe(Layer.provide(sqlLayer)),
  ProviderInstallationRepositoryLive.pipe(Layer.provide(sqlLayer)),
);
const dependencies = Layer.mergeAll(
  repositories,
  configLayer,
  Layer.succeed(ProviderCredentialBroker, {
    available: true,
    store: () => Effect.die("unused"),
    claim: (secret: string, reference: string) =>
      claimFailure === null
        ? Effect.sync(() => {
            credentialClaims.push({ secret, reference });
            return reference;
          })
        : Effect.fail(new ProviderCredentialBrokerError({ message: claimFailure })),
    lease: () => Effect.die("unused"),
    consume: () => Effect.die("unused"),
    readOnce: () => Effect.die("unused"),
    has: () => Effect.succeed(false),
    remove: (reference: string) =>
      Effect.sync(() => {
        releasedCredentialClaims.push(reference);
      }),
  }),
);
const coordinatorLayer = Layer.effect(
  ProviderConnectionLoginCoordinator,
  makeProviderConnectionLoginCoordinator({
    newId: () => `managed-login-${++id}`,
    now: () => timestamp,
    startLogin,
    startApiKeyImport,
    probeAccount: async () => {
      if (probeFailure !== null) {
        const failure = probeFailure;
        probeFailure = null;
        throw failure;
      }
      return probedAccount;
    },
    logout: async () => {
      logoutCount += 1;
      if (logoutFailure !== null) throw logoutFailure;
      probedAccount = null;
    },
  }),
).pipe(Layer.provide(dependencies));
const layer = it.layer(
  Layer.mergeAll(sqlLayer, NodeServices.layer, dependencies, coordinatorLayer),
);

const activateCodex = Effect.gen(function* () {
  const installations = yield* ProviderInstallationRepository;
  yield* installations.activate({
    id: ProviderInstallationId.makeUnsafe("managed-codex-installation"),
    harness: "codex",
    version: "0.147.0",
    platform: "darwin",
    architecture: "arm64",
    executablePath: "/managed/codex",
    artifactSource: "test",
    artifactUrl: "https://example.invalid/codex",
    artifactSha256: "a".repeat(64),
    adapterVersion: "1",
    protocolVersion: "v1",
    installedAt: timestamp,
    activatedAt: timestamp,
  });
});

const waitForCompleted = (operationId: string) =>
  Effect.gen(function* () {
    const coordinator = yield* ProviderConnectionLoginCoordinator;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const snapshot = yield* coordinator.get({ operationId });
      if (snapshot.state === "completed") return snapshot;
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
    }
    return yield* Effect.die("managed login did not complete");
  });

const waitForFailed = (operationId: string) =>
  Effect.gen(function* () {
    const coordinator = yield* ProviderConnectionLoginCoordinator;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const snapshot = yield* coordinator.get({ operationId });
      if (snapshot.state === "failed") return snapshot;
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
    }
    return yield* Effect.die("managed login did not fail");
  });

layer("ProviderConnectionLoginCoordinator", (it) => {
  it.effect("commits an API-key Connection after the native import verifies it", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* activateCodex;
      importedApiKey = null;
      credentialClaims.length = 0;
      const coordinator = yield* ProviderConnectionLoginCoordinator;
      const started = yield* coordinator.begin({
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "api-key",
        secret: "test-api-key",
      });

      assert.strictEqual(started.state, "awaiting-user");
      assert.strictEqual(importedApiKey, "test-api-key");
      assert.deepStrictEqual(credentialClaims, [
        {
          secret: "test-api-key",
          reference: `provider-secret:${started.connectionId}`,
        },
      ]);
      pendingApiKeyImport?.resolve({ type: "api-key" });
      const completed = yield* waitForCompleted(started.operationId);
      assert.strictEqual(completed.connection?.authenticationMethodId, "api-key");
      assert.strictEqual(completed.connection?.label, "API / ••••-key");
      assert.strictEqual(completed.connection?.providerIdentityId, null);
    }),
  );

  it.effect("rejects a duplicate API credential before native import", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* activateCodex;
      importedApiKey = null;
      claimFailure = "This provider credential is already configured.";
      const coordinator = yield* ProviderConnectionLoginCoordinator;
      const failure = yield* coordinator
        .begin({
          harness: "codex",
          authenticationTargetId: "openai-first-party",
          authenticationMethodId: "api-key",
          secret: "duplicate-api-key",
        })
        .pipe(Effect.flip);
      claimFailure = null;

      assert.strictEqual(failure.detail, "This provider credential is already configured.");
      assert.strictEqual(importedApiKey, null);
    }),
  );

  it.effect("commits a Connection only after the native login verifies the account", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* activateCodex;
      const coordinator = yield* ProviderConnectionLoginCoordinator;
      const connections = yield* ProviderConnectionRepository;
      const started = yield* coordinator.begin({
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "chatgpt",
      });
      assert.strictEqual(started.state, "awaiting-user");
      assert.strictEqual(Option.isNone(yield* connections.getRecord(started.connectionId)), true);
      pendingLogin?.resolve({ type: "chatgpt", email: "person@example.com", planType: "pro" });
      const completed = yield* waitForCompleted(started.operationId);
      assert.strictEqual(completed.connection?.label, "person@example.com");
      assert.strictEqual(completed.connection?.providerIdentityId, "person@example.com");
    }),
  );

  it.effect("recovers an interrupted login only from the exact isolated account state", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* activateCodex;
      const coordinator = yield* ProviderConnectionLoginCoordinator;
      const logins = yield* ProviderConnectionLoginRepository;
      const connections = yield* ProviderConnectionRepository;
      const connectionId = ProviderConnectionId.makeUnsafe("recovered-managed-connection");
      probeFailure = null;
      yield* logins.begin({
        operationId: "recovered-managed-login",
        connectionId,
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "chatgpt",
        label: "Recovered",
        profileRef: `provider-profile:${connectionId}`,
        providerLoginId: "native-login",
        state: "awaiting-user",
        providerIdentityId: null,
        failureReason: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      probedAccount = { type: "chatgpt", email: "recovered@example.com", planType: "pro" };
      yield* coordinator.recover;
      const recovered = Option.getOrThrow(yield* connections.getRecord(connectionId));
      assert.strictEqual(recovered.label, "recovered@example.com");
      assert.strictEqual(recovered.providerIdentityId, "recovered@example.com");
      assert.deepStrictEqual(yield* logins.listOpen(), []);
    }),
  );

  it.effect("fails an unverifiable interrupted login without blocking server recovery", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* activateCodex;
      const coordinator = yield* ProviderConnectionLoginCoordinator;
      const logins = yield* ProviderConnectionLoginRepository;
      const connections = yield* ProviderConnectionRepository;
      const connectionId = ProviderConnectionId.makeUnsafe("unverifiable-managed-connection");
      yield* logins.begin({
        operationId: "unverifiable-managed-login",
        connectionId,
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "chatgpt",
        label: "Unverifiable",
        profileRef: `provider-profile:${connectionId}`,
        providerLoginId: "native-login",
        state: "awaiting-user",
        providerIdentityId: null,
        failureReason: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      probeFailure = new Error("native status failed");

      yield* coordinator.recover;

      const failed = yield* coordinator.get({ operationId: "unverifiable-managed-login" });
      assert.strictEqual(failed.state, "failed");
      assert.strictEqual(
        failed.failureReason,
        "The isolated provider profile could not be verified.",
      );
      assert.strictEqual(Option.isNone(yield* connections.getRecord(connectionId)), true);
      probeFailure = null;
    }),
  );

  it.effect("rejects a duplicate provider identity and cleans the uncommitted profile", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* activateCodex;
      const coordinator = yield* ProviderConnectionLoginCoordinator;
      const connections = yield* ProviderConnectionRepository;
      logoutCount = 0;

      const first = yield* coordinator.begin({
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "chatgpt",
      });
      pendingLogin?.resolve({ type: "chatgpt", email: "same@example.com", planType: "pro" });
      yield* waitForCompleted(first.operationId);

      const duplicate = yield* coordinator.begin({
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "chatgpt",
      });
      probedAccount = { type: "chatgpt", email: "same@example.com", planType: "pro" };
      pendingLogin?.resolve({ type: "chatgpt", email: "same@example.com", planType: "pro" });
      const failed = yield* waitForFailed(duplicate.operationId);

      assert.strictEqual(failed.connection, null);
      assert.strictEqual(failed.failureReason, "This provider account is already connected.");
      assert.strictEqual(logoutCount, 1);
      assert.strictEqual(Option.isNone(yield* connections.getRecord(duplicate.connectionId)), true);
      assert.strictEqual(
        Option.getOrThrow(yield* connections.getRecord(first.connectionId)).lifecycle,
        "active",
      );
    }),
  );

  it.effect("retires an active managed Connection when its isolated account signed out", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* activateCodex;
      const coordinator = yield* ProviderConnectionLoginCoordinator;
      const connections = yield* ProviderConnectionRepository;
      const connectionId = ProviderConnectionId.makeUnsafe("signed-out-managed-connection");
      yield* connections.create({
        id: connectionId,
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "chatgpt",
        label: "Signed out",
        credentialRef: null,
        profileRef: `provider-profile:${connectionId}`,
        providerIdentityId: null,
        createdAt: timestamp,
      });
      probedAccount = null;
      yield* coordinator.recover;
      const recovered = Option.getOrThrow(yield* connections.getRecord(connectionId));
      assert.strictEqual(recovered.lifecycle, "terminated");
      assert.strictEqual(recovered.terminationReason, "signed-out");
    }),
  );

  it.effect("keeps an active managed Connection when its isolated account remains signed in", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* activateCodex;
      const coordinator = yield* ProviderConnectionLoginCoordinator;
      const connections = yield* ProviderConnectionRepository;
      const connectionId = ProviderConnectionId.makeUnsafe("active-managed-connection");
      yield* connections.create({
        id: connectionId,
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "chatgpt",
        label: "Still active",
        credentialRef: null,
        profileRef: `provider-profile:${connectionId}`,
        providerIdentityId: null,
        createdAt: timestamp,
      });
      probedAccount = { type: "chatgpt", email: "active@example.com", planType: "pro" };
      yield* coordinator.recover;
      const recovered = Option.getOrThrow(yield* connections.getRecord(connectionId));
      assert.strictEqual(recovered.lifecycle, "active");
      assert.strictEqual(recovered.label, "active@example.com");
      assert.strictEqual(recovered.providerIdentityId, "active@example.com");
      assert.strictEqual(recovered.terminationReason, null);
    }),
  );

  it.effect("canonicalizes provider account emails before enforcing identity uniqueness", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* activateCodex;
      const coordinator = yield* ProviderConnectionLoginCoordinator;

      const first = yield* coordinator.begin({
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "chatgpt",
      });
      pendingLogin?.resolve({ type: "chatgpt", email: "Same@Example.com", planType: "pro" });
      const completed = yield* waitForCompleted(first.operationId);
      assert.strictEqual(completed.connection?.providerIdentityId, "same@example.com");
      assert.strictEqual(completed.connection?.label, "same@example.com");

      const duplicate = yield* coordinator.begin({
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "chatgpt",
      });
      probedAccount = { type: "chatgpt", email: "same@example.com", planType: "pro" };
      pendingLogin?.resolve({ type: "chatgpt", email: "same@example.com", planType: "pro" });
      const failed = yield* waitForFailed(duplicate.operationId);
      assert.strictEqual(failed.connection, null);
      assert.strictEqual(failed.failureReason, "This provider account is already connected.");
    }),
  );

  it.effect("logs out and verifies a managed account before disconnecting it", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* activateCodex;
      logoutCount = 0;
      probedAccount = null;
      const coordinator = yield* ProviderConnectionLoginCoordinator;
      const connections = yield* ProviderConnectionRepository;
      const connectionId = ProviderConnectionId.makeUnsafe("disconnected-managed-connection");
      yield* connections.create({
        id: connectionId,
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "chatgpt",
        label: "Disconnect me",
        credentialRef: null,
        profileRef: `provider-profile:${connectionId}`,
        providerIdentityId: null,
        createdAt: timestamp,
      });

      const disconnected = yield* coordinator.terminateProfile({
        connectionId,
        reason: "disconnected",
      });
      assert.strictEqual(logoutCount, 1);
      assert.strictEqual(disconnected.lifecycle, "terminated");
      assert.strictEqual(disconnected.terminationReason, "disconnected");
    }),
  );

  it.effect("keeps a managed Connection active when provider logout fails", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* activateCodex;
      logoutFailure = new Error("logout failed");
      const coordinator = yield* ProviderConnectionLoginCoordinator;
      const connections = yield* ProviderConnectionRepository;
      const connectionId = ProviderConnectionId.makeUnsafe("failed-disconnect-managed-connection");
      yield* connections.create({
        id: connectionId,
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "chatgpt",
        label: "Keep me",
        credentialRef: null,
        profileRef: `provider-profile:${connectionId}`,
        providerIdentityId: null,
        createdAt: timestamp,
      });

      const result = yield* Effect.exit(
        coordinator.terminateProfile({ connectionId, reason: "disconnected" }),
      );
      logoutFailure = null;
      assert.strictEqual(result._tag, "Failure");
      const preserved = Option.getOrThrow(yield* connections.getRecord(connectionId));
      assert.strictEqual(preserved.lifecycle, "active");
    }),
  );

  it.effect("verifies provider logout before cancelling an uncommitted login", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* activateCodex;
      logoutCount = 0;
      probedAccount = null;
      const coordinator = yield* ProviderConnectionLoginCoordinator;
      const started = yield* coordinator.begin({
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "chatgpt",
      });
      const cancelled = yield* coordinator.cancel({ operationId: started.operationId });
      assert.strictEqual(cancelled.state, "cancelled");
      assert.strictEqual(logoutCount, 1);
    }),
  );

  it.effect("terminalizes a native startup failure before returning the error", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* activateCodex;
      startFailure = new Error("native app-server failed");
      const coordinator = yield* ProviderConnectionLoginCoordinator;
      const logins = yield* ProviderConnectionLoginRepository;
      const failed = yield* Effect.exit(
        coordinator.begin({
          harness: "codex",
          authenticationTargetId: "openai-first-party",
          authenticationMethodId: "chatgpt",
        }),
      );
      startFailure = null;
      assert.strictEqual(failed._tag, "Failure");
      assert.deepStrictEqual(yield* logins.listOpen(), []);
    }),
  );
});
