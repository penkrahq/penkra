import { IconFileDiff } from "@tabler/icons-react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { PanelTabShared } from "./PanelTabShared";

const meta = {
  component: PanelTabShared,
  parameters: { pencil: { componentId: "nyAGp", groupId: "DH1W8", statesId: "FZRZ9" } },
  title: "Right Panel/Panel Tab/Shared",
} satisfies Meta<typeof PanelTabShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Files: Story = {};
export const ReviewSelected: Story = {
  args: { active: true, children: "Review", icon: <IconFileDiff />, onClose: () => {} },
};
