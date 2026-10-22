import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.config.ts";

// Native contracts are an explicit release/bump gate, not part of the fake-
// provider unit suite. A missing binary fails this gate; nothing is skipped.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["integration/provider-contracts/*.contract.ts"],
      testTimeout: 120_000,
      hookTimeout: 120_000,
      maxWorkers: 1,
      fileParallelism: false,
    },
  }),
);
