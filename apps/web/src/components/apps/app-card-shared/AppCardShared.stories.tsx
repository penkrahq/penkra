import type { Meta, StoryObj } from "@storybook/react-vite";

import { AppCardShared } from "./AppCardShared";

const meta = {
  component: AppCardShared,
  parameters: {
    pencil: {
      componentId: "Q0YrUi",
      groupId: "o1aLe",
      states: ["default", "hover", "active", "disabled", "installed"],
    },
  },
  title: "Apps/App Card/Shared",
} satisfies Meta<typeof AppCardShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Installed: Story = { args: { checked: true } };
export const Disabled: Story = { args: { disabled: true } };
