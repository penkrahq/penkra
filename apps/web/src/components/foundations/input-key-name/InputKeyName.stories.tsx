import type { Meta, StoryObj } from "@storybook/react-vite";

import { InputKeyName } from "./InputKeyName";

const meta = {
  args: { "aria-label": "Key name" },
  component: InputKeyName,
  decorators: [(Story) => <div className="w-[488px]"><Story /></div>],
  parameters: { pencil: { componentId: "EpNo7", groupId: "fVh0u" } },
  title: "Foundations/Input/Key Name",
} satisfies Meta<typeof InputKeyName>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Focused: Story = {
  play: async ({ canvas }) => {
    await canvas.getByRole("textbox").focus();
  },
};
