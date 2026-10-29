import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: [
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
        "src/wsRpc.auth.test.ts",
        "src/auth/Layers/ServerAuth.test.ts",
      ],
      // Server integration tests exercise sqlite/git orchestration and can
      // legitimately exceed the default timeout when the full workspace suite
      // is running under CI load.
      testTimeout: 90_000,
      hookTimeout: 90_000,
    },
  }),
);
