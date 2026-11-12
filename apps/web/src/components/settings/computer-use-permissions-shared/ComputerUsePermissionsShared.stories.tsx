import type { Meta, StoryObj } from "@storybook/react-vite";

import { ComputerUsePermissionsShared } from "./ComputerUsePermissionsShared";

const meta = {
  component: ComputerUsePermissionsShared,
  title: "Settings/Computer Use Permissions",
  parameters: { layout: "padded" },
  args: { onOpen: () => {} },
} satisfies Meta<typeof ComputerUsePermissionsShared>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NotAllowed: Story = {
  args: {
    permissions: {
      accessibility: "denied",
      screenRecording: "not-determined",
      fullDiskAccess: "denied",
      accessibilityPaneName: "Device Control and Data Access",
    },
  },
};
export const OneAllowed: Story = {
  args: {
    permissions: {
      accessibility: "granted",
      screenRecording: "denied",
      fullDiskAccess: "denied",
      accessibilityPaneName: "Device Control and Data Access",
    },
  },
};
export const BothAllowed: Story = {
  args: {
    permissions: {
      accessibility: "granted",
      screenRecording: "granted",
      fullDiskAccess: "granted",
      accessibilityPaneName: "Device Control and Data Access",
    },
  },
};
export const Checking: Story = { args: { permissions: null } };
