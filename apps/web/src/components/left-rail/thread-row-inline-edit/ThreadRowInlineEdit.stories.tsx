import type { Meta, StoryObj } from "@storybook/react-vite";

import { ThreadRowInlineEdit } from "./ThreadRowInlineEdit";

const meta = {
  component: ThreadRowInlineEdit,
  args: {
    defaultValue: "Investigate voice state",
    onCancel: () => undefined,
    onSubmit: () => undefined,
  },
  decorators: [
    (Story) => (
      <div className="w-56">
        <Story />
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "VrNdb" } },
  title: "Left Rail/Thread Row/Inline Edit",
} satisfies Meta<typeof ThreadRowInlineEdit>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
