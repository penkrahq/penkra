import type { Meta, StoryObj } from "@storybook/react-vite";

import { AccessPillContent } from "./AccessPillContent";

const meta = {
  component: AccessPillContent,
  decorators: [
    (Story) => (
      <div className="flex items-center gap-1 text-xs text-orange-500">
        <Story />
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "k4x6m", groupId: "kVpYl" } },
  title: "Middle Panel/Access Pill/Content",
} satisfies Meta<typeof AccessPillContent>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
