import type { Meta, StoryObj } from "@storybook/react-vite";

import { PillCategory } from "./PillCategory";

const meta = {
  component: PillCategory,
  parameters: { pencil: { componentId: "tNSs3", groupId: "o1aLe" } },
  title: "Apps/Pill/Category",
} satisfies Meta<typeof PillCategory>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Selected: Story = { args: { children: "All", selected: true } };
