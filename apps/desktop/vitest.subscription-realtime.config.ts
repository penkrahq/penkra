import { defineConfig } from "vitest/config";

// The reviewer requires a real quiet interval beyond the former 120-second host timer.
// Run this integration explicitly once; keep the ordinary per-commit suites fast.
export default defineConfig({
  test: {
    include: ["src/appControllerSubscriptions.realtime.integration.ts"],
    testTimeout: 180_000,
  },
});
