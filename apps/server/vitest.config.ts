import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: [
        "src/localImageRoute.test.ts",
        "src/workspace/Layers/WorkspacePaths.test.ts",
        "src/cleanCore/threadQueue.test.ts",
        "src/persistence/SqliteSafety.test.ts",
        "src/provider/providerConnectionManifests.test.ts",
        "src/provider/providerCredentialBroker.test.ts",
        "src/remoteLink/relaySessions.test.ts",
        "src/remoteLink/pairingControl.test.ts",
        "src/auth/Layers/BootstrapCredentialService.test.ts",
        "src/provider/pinnedProviderRuntimes.test.ts",
        "src/provider/providerPermissionPolicy.test.ts",
        "src/agentGateway/Layers/AgentGateway.test.ts",
        "src/remoteLink/pushSender.test.ts",
        "src/remoteLink/relaySessionStart.test.ts",
        "src/agentGateway/diagnosticSanitizer.test.ts",
        "src/agentGateway/commandSurface.test.ts",
        "src/remoteLink/devicesControl.test.ts",
        "src/remoteLink/tunnelPaths.test.ts",
        "src/remoteLink/relayProtocol.test.ts",
        "src/remoteLink/pairingProtocol.test.ts",
        "src/remoteLink/tunnelCodec.test.ts",
        "src/remoteLink/wsTextChunks.test.ts",
        "src/remoteLink/wsTextReceiver.test.ts",
        "src/remoteLink/sendWindow.test.ts",
        "src/remoteLink/sealedPush.test.ts",
        "src/persistence/Migrations.test.ts",
        "src/persistence/MigrationBackup.test.ts",
        "src/restoreMigrationBackup.test.ts",
        "src/provider/ThreadRuntime.test.ts",
        "src/codexAppServerManager.test.ts",
        "src/wsRpc.auth.test.ts",
        "src/auth/Layers/ServerAuth.test.ts",
        "src/authEffectRoute.test.ts",
        "src/auth/Layers/SessionCredentialService.test.ts",
      ],
      // Server integration tests exercise sqlite/git orchestration and can
      // legitimately exceed the default timeout when the full workspace suite
      // is running under CI load.
      testTimeout: 90_000,
      hookTimeout: 90_000,
    },
  }),
);
