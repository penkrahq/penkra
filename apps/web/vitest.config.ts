import { mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.ts";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
  {
    ...viteConfig,
    server: {
      ...viteConfig.server,
      // Unit tests do not launch the desktop's eagerly warmed chat route.
      warmup: undefined,
    },
  },
  baseConfig,
);
