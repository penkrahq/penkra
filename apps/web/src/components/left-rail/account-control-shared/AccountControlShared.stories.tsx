import type { Meta, StoryObj } from "@storybook/react-vite";

import { AccountControlShared } from "./AccountControlShared";

const meta = {
  component: AccountControlShared,
  decorators: [
    (Story) => (
      <div className="flex h-64 w-60 items-end">
        <Story />
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "ptpcV", groupId: "PUf7t", statesId: "g1UL3" } },
  title: "Left Rail/Account Control/Shared",
} satisfies Meta<typeof AccountControlShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
