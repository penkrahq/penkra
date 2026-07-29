import type { Meta, StoryObj } from "@storybook/react-vite";

import { SidebarHeaderShared } from "./SidebarHeaderShared";

const meta = {
  component: SidebarHeaderShared,
  parameters: { pencil: { componentId: "xpOxQ", groupId: "PUf7t" } },
  title: "Left Rail/Sidebar Header/Shared",
} satisfies Meta<typeof SidebarHeaderShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Penkra: Story = {};
export const WithBrandMenu: Story = { args: { brand: "Codex", showBrandMenu: true } };
