import type { Meta, StoryObj } from "@storybook/react-vite";

import { OpenWithRowShared } from "./OpenWithRowShared";

const meta = {
  component: OpenWithRowShared,
  decorators: [(Story) => <div className="w-[440px]"><Story /></div>],
  parameters: { pencil: { componentId: "MqhKC", groupId: "L8Pc7b" } },
  title: "Settings/Open With Row/Shared",
} satisfies Meta<typeof OpenWithRowShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
