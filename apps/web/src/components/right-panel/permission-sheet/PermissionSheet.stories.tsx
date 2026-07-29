import type { Meta, StoryObj } from "@storybook/react-vite";

import { PermissionSheet } from "./PermissionSheet";

const meta = {
  component: PermissionSheet,
  parameters: { pencil: { componentId: "p3iWcp", groupId: "DH1W8" } },
  title: "Right Panel/Permission Sheet",
} satisfies Meta<typeof PermissionSheet>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
