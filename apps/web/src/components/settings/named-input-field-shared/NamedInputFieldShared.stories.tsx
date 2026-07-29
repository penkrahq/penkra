import type { Meta, StoryObj } from "@storybook/react-vite";

import { NamedInputFieldShared } from "./NamedInputFieldShared";

const meta = {
  args: { placeholder: "Emmanuel" },
  component: NamedInputFieldShared,
  decorators: [(Story) => <div className="w-[488px]"><Story /></div>],
  parameters: { pencil: { componentId: "C9kHj", groupId: "L8Pc7b" } },
  title: "Settings/Named Input Field/Shared",
} satisfies Meta<typeof NamedInputFieldShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
