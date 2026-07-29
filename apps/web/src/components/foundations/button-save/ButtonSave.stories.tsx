import type { Meta, StoryObj } from "@storybook/react-vite";

import { ButtonSave } from "./ButtonSave";

const meta = {
  component: ButtonSave,
  decorators: [(Story) => <div className="w-[488px]"><Story /></div>],
  parameters: { pencil: { componentId: "eWmft", groupId: "fVh0u" } },
  title: "Foundations/Button/Save",
} satisfies Meta<typeof ButtonSave>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
