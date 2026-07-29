import type { Meta, StoryObj } from "@storybook/react-vite";

import { ButtonPrimary } from "./ButtonPrimary";

const meta = {
  args: { children: "Create an account" },
  component: ButtonPrimary,
  decorators: [(Story) => <div className="w-[488px]"><Story /></div>],
  parameters: { pencil: { componentId: "TecAX", groupId: "fVh0u", statesId: "uAdKP" } },
  title: "Foundations/Button/Primary",
} satisfies Meta<typeof ButtonPrimary>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Hover: Story = { args: { className: "!bg-[var(--pencil-accent-hover)]" } };
export const Active: Story = { args: { className: "!bg-[var(--pencil-accent-active)]" } };
export const Selected: Story = { args: { "aria-pressed": true } };
export const Disabled: Story = { args: { disabled: true } };
