import { IconSearch } from "@tabler/icons-react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { NavItemShared } from "./NavItemShared";

const meta = {
  args: { children: "Search", icon: <IconSearch /> },
  component: NavItemShared,
  decorators: [
    (Story) => (
      <div className="w-56">
        <Story />
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "cMq8Y", groupId: "PUf7t", statesId: "N0dG2o" } },
  title: "Left Rail/Nav Item/Shared",
} satisfies Meta<typeof NavItemShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Selected: Story = { args: { state: "selected" } };
export const Open: Story = { args: { state: "open" } };
export const Disabled: Story = { args: { disabled: true } };
