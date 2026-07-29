import type { Meta, StoryObj } from "@storybook/react-vite";

import { AppPickerRowShared } from "./AppPickerRowShared";

const meta = {
  component: AppPickerRowShared,
  decorators: [(Story) => <div className="w-[440px]"><Story /></div>],
  parameters: { pencil: { componentId: "D3Mg1V", groupId: "L8Pc7b", statesId: "Ns7XV" } },
  title: "Settings/App Picker Row/Shared",
} satisfies Meta<typeof AppPickerRowShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Selected: Story = { args: { selected: true } };
