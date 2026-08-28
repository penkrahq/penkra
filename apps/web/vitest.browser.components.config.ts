import { defineConfig } from "vitest/config";

import browserConfig from "./vitest.browser.config.ts";

export default defineConfig({
  ...browserConfig,
  test: {
    ...browserConfig.test,
    exclude: ["src/components/ChatView.browser.tsx"],
  },
});
