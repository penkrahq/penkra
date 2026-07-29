import type { Meta, StoryObj } from "@storybook/react-vite";

import { MenuModel } from "./MenuModel";

const meta = {
  component: MenuModel,
  parameters: { pencil: { componentId: "x8Fk3j", groupId: "kVpYl" } },
  title: "Middle Panel/Menu/Model",
} satisfies Meta<typeof MenuModel>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
