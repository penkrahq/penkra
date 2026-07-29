import type { Meta, StoryObj } from "@storybook/react-vite";

import { ButtonBack } from "./ButtonBack";

const meta = {
  component: ButtonBack,
  parameters: { pencil: { componentId: "HfU75", groupId: "fVh0u", statesId: "yP1QC" } },
  title: "Foundations/Button/Back",
} satisfies Meta<typeof ButtonBack>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Hover: Story = {
  args: { className: "!text-[var(--color-text-foreground)]" },
};
export const Active: Story = {
  args: { className: "!text-[var(--color-text-foreground)]" },
};
export const Disabled: Story = { args: { disabled: true } };
