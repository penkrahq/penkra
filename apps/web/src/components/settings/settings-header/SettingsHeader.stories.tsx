import type { Meta, StoryObj } from "@storybook/react-vite";

import { SettingsHeader } from "./SettingsHeader";

const meta = {
  component: SettingsHeader,
  parameters: { pencil: { componentId: "w2pbCe", groupId: "L8Pc7b" } },
  title: "Settings/Settings Header",
} satisfies Meta<typeof SettingsHeader>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = { args: { title: "Appearance" } };
