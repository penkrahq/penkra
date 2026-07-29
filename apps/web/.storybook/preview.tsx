import "@fontsource-variable/jetbrains-mono";
import "../src/index.css";

import type { Preview } from "@storybook/react-vite";

import {
  buildThemeCssVariables,
  DEFAULT_THEME_STATE,
  resolveThemePack,
} from "../src/theme/theme.logic";

const preview = {
  decorators: [
    (Story, context) => {
      const dark = context.globals.theme === "dark";
      const variant = dark ? "dark" : "light";
      const root = document.documentElement;
      const theme = buildThemeCssVariables(
        resolveThemePack(DEFAULT_THEME_STATE, variant),
        variant,
        { electron: true, isMac: true },
      );

      root.classList.toggle("dark", dark);
      root.dataset.themeMode = variant;
      root.dataset.themeVariant = variant;
      root.dataset.runtime = "electron";
      for (const [name, value] of Object.entries(theme.variables)) {
        root.style.setProperty(name, value);
      }

      return (
        <div className="min-h-screen bg-background p-6 text-foreground">
          <Story />
        </div>
      );
    },
  ],
  globalTypes: {
    theme: {
      description: "Desktop color theme",
      name: "Theme",
      toolbar: {
        dynamicTitle: true,
        icon: "paintbrush",
        items: [
          { icon: "moon", title: "Dark", value: "dark" },
          { icon: "sun", title: "Light", value: "light" },
        ],
      },
    },
  },
  initialGlobals: {
    theme: "dark",
  },
  parameters: {
    actions: {
      disable: true,
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
      sort: "requiredFirst",
    },
    layout: "centered",
    pencil: {
      file: "penkra.pen",
      repository: "penkra",
    },
  },
  tags: ["autodocs"],
} satisfies Preview;

export default preview;
