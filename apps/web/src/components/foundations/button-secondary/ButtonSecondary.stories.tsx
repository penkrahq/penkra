import type { Meta, StoryObj } from "@storybook/react-vite";

import { ButtonSecondary } from "./ButtonSecondary";

const meta = {
  args: { children: "Sign in" },
  component: ButtonSecondary,
  decorators: [(Story) => <div className="w-[488px]"><Story /></div>],
  parameters: { pencil: { componentId: "LsMFv", groupId: "fVh0u", statesId: "L6vfi" } },
  title: "Foundations/Button/Secondary",
} satisfies Meta<typeof ButtonSecondary>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Hover: Story = {
  args: {
    className: "!bg-white/5 !text-[var(--pencil-text-primary)]",
  },
};
export const Active: Story = {
  args: {
    className: "!bg-[var(--pencil-disabled)] !text-[var(--pencil-text-primary)]",
  },
};
export const Selected: Story = { args: { "aria-pressed": true } };
export const Disabled: Story = { args: { disabled: true } };
