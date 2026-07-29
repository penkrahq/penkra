import type { Meta, StoryObj } from "@storybook/react-vite";

import { PermissionRowShared } from "./PermissionRowShared";

const meta = {
  component: PermissionRowShared,
  decorators: [(Story) => <div className="w-[400px]"><Story /></div>],
  parameters: { pencil: { componentId: "t8z9QM", groupId: "o1aLe", storiesId: "lc3rP" } },
  title: "Apps/Permission Row/Shared",
} satisfies Meta<typeof PermissionRowShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const OptionalOn: Story = {};
export const OptionalOff: Story = { args: { checked: false } };
export const Required: Story = { args: { required: true } };
