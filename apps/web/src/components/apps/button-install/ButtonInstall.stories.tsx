import type { Meta, StoryObj } from "@storybook/react-vite";

import { ButtonInstall } from "./ButtonInstall";

const meta = {
  component: ButtonInstall,
  parameters: { pencil: { componentId: "GYrNw", groupId: "o1aLe" } },
  title: "Apps/Button/Install",
} satisfies Meta<typeof ButtonInstall>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Install: Story = {};
export const Open: Story = { args: { installed: true } };
