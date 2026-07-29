import type { Meta, StoryObj } from "@storybook/react-vite";

import { PermissionToggleShared } from "./PermissionToggleShared";

const meta = {
  args: { "aria-label": "Allow permission" },
  component: PermissionToggleShared,
  parameters: { pencil: { componentId: "cF2PT", groupId: "DH1W8" } },
  title: "Right Panel/Permission Toggle/Shared",
} satisfies Meta<typeof PermissionToggleShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Off: Story = {};
export const On: Story = { args: { defaultChecked: true } };
