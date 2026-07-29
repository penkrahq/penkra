import type { Meta, StoryObj } from "@storybook/react-vite";

import { PermissionSection } from "./PermissionSection";

const meta = {
  component: PermissionSection,
  decorators: [(Story) => <div className="w-[390px]"><Story /></div>],
  parameters: {
    pencil: { componentId: "uGQk1", groupId: "DH1W8", relatedId: "WzUMN" },
  },
  title: "Right Panel/Permission Section",
} satisfies Meta<typeof PermissionSection>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Required: Story = {};
export const Optional: Story = { args: { required: false } };
