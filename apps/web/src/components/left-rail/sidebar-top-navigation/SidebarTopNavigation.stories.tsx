import type { Meta, StoryObj } from "@storybook/react-vite";

import { SidebarTopNavigation } from "./SidebarTopNavigation";

const meta = {
  component: SidebarTopNavigation,
  parameters: { pencil: { componentId: "dxWQT", groupId: "PUf7t" } },
  title: "Left Rail/Sidebar Top Navigation",
} satisfies Meta<typeof SidebarTopNavigation>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const AppsSelected: Story = { args: { activeItemId: "apps" } };
