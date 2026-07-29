import type { Meta, StoryObj } from "@storybook/react-vite";

import { MenuHarness } from "./MenuHarness";

const meta = {
  component: MenuHarness,
  parameters: { pencil: { componentId: "FLLg5", groupId: "kVpYl" } },
  title: "Middle Panel/Menu/Harness",
} satisfies Meta<typeof MenuHarness>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
