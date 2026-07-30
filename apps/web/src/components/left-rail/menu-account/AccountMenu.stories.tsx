import type { Meta, StoryObj } from "@storybook/react-vite";

import { Menu, MenuTrigger } from "~/components/ui/menu";

import { AccountMenu } from "./AccountMenu";

const meta: Meta<typeof AccountMenu> = {
  component: AccountMenu,
  decorators: [
    (Story) => (
      <div className="flex h-64 w-60 items-end">
        <Menu defaultOpen>
          <MenuTrigger>Account</MenuTrigger>
          <Story />
        </Menu>
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "KjCFX", groupId: "PUf7t" } },
  title: "Left Rail/Menu/Account",
};

export default meta;
type Story = StoryObj<typeof meta>;
export const Open: Story = {};
