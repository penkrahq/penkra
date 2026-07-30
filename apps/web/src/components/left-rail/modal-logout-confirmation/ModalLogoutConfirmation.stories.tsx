import type { Meta, StoryObj } from "@storybook/react-vite";

import { ModalLogoutConfirmation } from "./ModalLogoutConfirmation";

const meta = {
  component: ModalLogoutConfirmation,
  decorators: [
    (Story) => (
      <div className="flex min-h-screen items-center justify-center bg-[var(--color-background-surface-under)]">
        <Story />
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "r88fa", groupId: "PUf7t" } },
  title: "Left Rail/Modal/Logout Confirmation",
} satisfies Meta<typeof ModalLogoutConfirmation>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { loading: true } };
