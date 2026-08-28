import { defineConfig } from "vitest/config";

import browserConfig from "./vitest.browser.config.ts";

export default defineConfig({
  ...browserConfig,
  test: {
    ...browserConfig.test,
    include: ["src/components/ChatView.browser.tsx"],
  },
});
