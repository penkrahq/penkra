import type { Meta, StoryObj } from "@storybook/react-vite";

import { PenkraMark } from "./PenkraMark";

const meta = {
  args: { "aria-label": "Penkra", className: "size-24" },
  component: PenkraMark,
  decorators: [
    (Story) => (
      <div className="flex min-h-64 items-center justify-center bg-[var(--color-background-surface)]">
        <Story />
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "XUUPq", groupId: "fVh0u" } },
  title: "Foundations/Penkra Mark/Shared",
} satisfies Meta<typeof PenkraMark>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Monochrome: Story = { args: { monochrome: true } };
