import type { Meta, StoryObj } from "@storybook/react-vite";

import { TopBarThread } from "./TopBarThread";

const meta = {
  component: TopBarThread,
  parameters: { pencil: { componentId: "Kpx7i", groupId: "e46ib4" } },
  title: "Middle Panel/Top Bar/Thread",
} satisfies Meta<typeof TopBarThread>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {
  args: { harness: "codex" },
};

export const OpenCodePinned: Story = {
  args: { harness: "opencode", pinned: true },
};

export const LeftRailCollapsed: Story = {
  args: { leftRailCollapsed: true },
};
