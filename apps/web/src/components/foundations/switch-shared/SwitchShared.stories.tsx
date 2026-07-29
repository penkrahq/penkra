import type { Meta, StoryObj } from "@storybook/react-vite";

import { SwitchShared } from "./SwitchShared";

const meta = {
  args: { "aria-label": "Example setting" },
  component: SwitchShared,
  parameters: {
    pencil: { componentId: "X2HjPs", groupId: "fVh0u", selectedInstanceId: "Z42HrH" },
  },
  title: "Foundations/Switch/Shared",
} satisfies Meta<typeof SwitchShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Off: Story = {};
export const On: Story = { args: { defaultChecked: true } };
export const Disabled: Story = { args: { disabled: true } };
