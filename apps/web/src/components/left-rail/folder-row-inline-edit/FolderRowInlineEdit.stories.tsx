import type { Meta, StoryObj } from "@storybook/react-vite";

import { FolderRowInlineEdit } from "./FolderRowInlineEdit";

const meta = {
  component: FolderRowInlineEdit,
  args: {
    defaultValue: "Product",
    existingNames: ["Personal", "Engineering"],
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
  parameters: { pencil: { componentId: "L1fWoQ" } },
  title: "Left Rail/Folder Row/Inline Edit",
} satisfies Meta<typeof FolderRowInlineEdit>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
