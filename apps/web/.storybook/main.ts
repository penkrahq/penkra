import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/react-vite";

const configDir = path.dirname(fileURLToPath(import.meta.url));

const config = {
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y"],
  core: {
    builder: {
      name: "@storybook/builder-vite",
      options: {
        // The application Vite config includes router generation and production-only
        // icon pruning. Stories need the same CSS and source alias, but not those
        // application lifecycle plugins.
        viteConfigPath: path.join(configDir, "vite.config.ts"),
      },
    },
  },
  docs: {
    defaultName: "Documentation",
  },
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  staticDirs: ["../public"],
  stories: ["../src/**/*.stories.@(js|jsx|mjs|ts|tsx)"],
} satisfies StorybookConfig;

export default config;
