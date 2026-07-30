import type { Meta, StoryObj } from "@storybook/react-vite";

import { LauncherItemShared } from "./LauncherItemShared";

const meta = {
  component: LauncherItemShared,
  parameters: { pencil: { componentId: "Cllpy", groupId: "o1aLe" } },
  title: "Apps/Launcher Item/Shared",
} satisfies Meta<typeof LauncherItemShared>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Browser: Story = { args: { label: "Browser" } };
