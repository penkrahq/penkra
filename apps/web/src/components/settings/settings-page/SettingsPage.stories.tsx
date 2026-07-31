import type { Meta, StoryObj } from "@storybook/react-vite";

import { SettingsPage } from "./SettingsPage";

const meta = {
  title: "Settings/Settings Page",
  component: SettingsPage,
  parameters: { layout: "fullscreen" },
  args: { page: "general" },
} satisfies Meta<typeof SettingsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const General: Story = {};
