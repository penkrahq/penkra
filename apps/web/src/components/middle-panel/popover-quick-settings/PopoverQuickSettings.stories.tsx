import type { Meta, StoryObj } from "@storybook/react-vite";

import { PopoverQuickSettings } from "./PopoverQuickSettings";

const meta = {
  component: PopoverQuickSettings,
  parameters: { pencil: { componentId: "e5zUfJ", groupId: "kVpYl" } },
  title: "Middle Panel/Popover/Quick Settings",
} satisfies Meta<typeof PopoverQuickSettings>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
