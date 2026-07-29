import type { Meta, StoryObj } from "@storybook/react-vite";

import { RightPanelShared } from "./RightPanelShared";

const meta = {
  args: { children: "Panel content" },
  component: RightPanelShared,
  parameters: { pencil: { componentId: "ayA7J", groupId: "DH1W8" } },
  title: "Right Panel/Right Panel/Shared",
} satisfies Meta<typeof RightPanelShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
