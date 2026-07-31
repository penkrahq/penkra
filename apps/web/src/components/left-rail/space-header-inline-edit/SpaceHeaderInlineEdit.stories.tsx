import type { Meta, StoryObj } from "@storybook/react-vite";

import { SpaceHeaderInlineEdit } from "./SpaceHeaderInlineEdit";

const meta = {
  title: "Left Rail/Space Header/Inline Edit",
  component: SpaceHeaderInlineEdit,
  args: {
    mode: "create",
    onCancel: () => undefined,
    onSubmit: () => undefined,
  },
  decorators: [
    (Story) => (
      <div className="w-56 p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SpaceHeaderInlineEdit>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Create: Story = {};

export const Rename: Story = {
  args: { defaultValue: "Personal", mode: "rename" },
};
