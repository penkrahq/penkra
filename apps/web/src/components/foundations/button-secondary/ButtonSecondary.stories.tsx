import type { Meta, StoryObj } from "@storybook/react-vite";

import { ButtonSecondary } from "./ButtonSecondary";

const meta = {
  args: { children: "Sign in" },
  component: ButtonSecondary,
  decorators: [
    (Story) => (
      <div className="w-[488px]">
        <Story />
      </div>
    ),
  ],
  parameters: {
    pencil: { componentId: "LsMFv", groupId: "fVh0u", statesId: "L6vfi" },
  },
  title: "Foundations/Button/Secondary",
} satisfies Meta<typeof ButtonSecondary>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Hover: Story = {
  args: {
    className:
      "!bg-[var(--color-background-button-secondary-hover)] !text-[var(--color-text-foreground)]",
  },
};
export const Active: Story = {
  args: {
    className:
      "!bg-[var(--color-background-button-secondary-active)] !text-[var(--color-text-foreground)]",
  },
};
export const Selected: Story = { args: { "aria-pressed": true } };
export const Disabled: Story = { args: { disabled: true } };
export const Loading: Story = {
  args: { loading: true, loadingLabel: "Signing in…" },
};
