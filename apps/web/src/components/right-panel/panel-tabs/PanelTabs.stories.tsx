import type { Meta, StoryObj } from "@storybook/react-vite";

import { PanelTabs } from "./PanelTabs";

const meta = {
  component: PanelTabs,
  decorators: [(Story) => <div className="w-[420px]"><Story /></div>],
  parameters: { pencil: { componentId: "x1igca", groupId: "DH1W8" } },
  title: "Right Panel/Panel Tabs",
} satisfies Meta<typeof PanelTabs>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Files: Story = {};
export const Review: Story = { args: { activeTab: "review" } };
