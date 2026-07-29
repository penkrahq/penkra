import type { Meta, StoryObj } from "@storybook/react-vite";

import { AccountMenu } from "./AccountMenu";

const meta = {
  args: {
    defaultOpen: true,
  },
  component: AccountMenu,
  decorators: [(Story) => <div className="flex h-64 w-60 items-end"><Story /></div>],
  parameters: { pencil: { componentId: "KjCFX", groupId: "PUf7t" } },
  title: "Left Rail/Menu/Account",
} satisfies Meta<typeof AccountMenu>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Open: Story = {};
