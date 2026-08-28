import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config.ts";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));
const browserViteConfig = {
  ...viteConfig,
  server: {
    ...viteConfig.server,
    // Desktop development deliberately warms the complete chat route before
    // Electron opens. A component-test server must stay focused on the files
    // selected by Vitest; inheriting that warmup makes even a one-file browser
    // test compile ChatView and its full route graph before Chromium can start.
    warmup: undefined,
  },
};

export default mergeConfig(
  browserViteConfig,
  defineConfig({
    resolve: {
      alias: {
        "~": srcPath,
      },
    },
    test: {
      include: [
        "src/components/**/*.browser.tsx",
        "src/lib/**/*.browser.ts",
        "src/lib/**/*.browser.tsx",
      ],
      browser: {
        enabled: true,
        provider: playwright(),
        instances: [{ browser: "chromium" }],
        headless: true,
        // A cold Playwright connection on release-QA machines can spend close
        // to a minute launching Chromium before the Vitest WebSocket is ready.
        // This governs only that documented connection boundary; assertion and
        // hook timeouts remain independently bounded below.
        connectTimeout: 120_000,
        // Large route-level suites can saturate Vite's transform server when
        // several browser files import concurrently, leaving Chromium with a
        // failed dynamic import instead of a test result. Run browser files in
        // one stable sequence; individual tests still use the same browser.
        fileParallelism: false,
        api: {
          // Vitest's default 63315 falls inside common Windows/Hyper-V
          // excluded-port ranges. Keep the local browser harness on IPv4 and
          // allow CI or developers to override the starting port. Browser QA
          // is independent of the desktop development server, so an occupied
          // starting port must advance to the next available port instead of
          // inheriting Vite's strict development-server policy.
          host: process.env.VITEST_BROWSER_API_HOST ?? "127.0.0.1",
          port: Number(process.env.VITEST_BROWSER_API_PORT ?? 51_100),
          strictPort: false,
        },
      },
      // The full desktop route graph can take more than 30 seconds to compile
      // on a cold Windows cache before an individual browser test can proceed.
      testTimeout: 90_000,
      hookTimeout: 90_000,
    },
  }),
);
