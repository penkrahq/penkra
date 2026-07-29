import type { Meta, StoryObj } from "@storybook/react-vite";

import { PermissionSheetInstall } from "./PermissionSheetInstall";

const meta = {
  component: PermissionSheetInstall,
  parameters: {
    pencil: { componentId: "r5wcGn", exampleId: "P8D5Ii", groupId: "o1aLe" },
  },
  title: "Apps/Permission Sheet/Install",
} satisfies Meta<typeof PermissionSheetInstall>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Ledger: Story = {};
