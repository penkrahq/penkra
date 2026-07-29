import "@fontsource-variable/jetbrains-mono";
import "../src/index.css";

import type { Preview } from "@storybook/react-vite";

const preview = {
  decorators: [
    (Story, context) => {
      const dark = context.globals.theme === "dark";
      const root = document.documentElement;

      root.classList.toggle("dark", dark);
      root.dataset.themeMode = dark ? "dark" : "light";
      root.dataset.themeVariant = dark ? "dark" : "light";
      root.dataset.runtime = "electron";

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
