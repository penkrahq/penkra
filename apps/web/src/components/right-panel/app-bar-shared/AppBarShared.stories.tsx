import type { Meta, StoryObj } from "@storybook/react-vite";

import { AppBarShared } from "./AppBarShared";

const meta = {
  component: AppBarShared,
  parameters: { pencil: { componentId: "HQgpR", groupId: "DH1W8" } },
  title: "Right Panel/App Bar/Shared",
} satisfies Meta<typeof AppBarShared>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const NavigationUnavailable: Story = {
  args: { canGoBack: false, canGoForward: false },
};
