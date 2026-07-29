import type { Meta, StoryObj } from "@storybook/react-vite";

import { OpenTabPickerRowShared } from "./OpenTabPickerRowShared";

const meta = {
  component: OpenTabPickerRowShared,
  decorators: [(Story) => <div className="w-[400px]"><Story /></div>],
  parameters: { pencil: { componentId: "r6PfmR", groupId: "DH1W8", statesId: "rBTKP" } },
  title: "Right Panel/Open Tab Picker Row/Shared",
} satisfies Meta<typeof OpenTabPickerRowShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
