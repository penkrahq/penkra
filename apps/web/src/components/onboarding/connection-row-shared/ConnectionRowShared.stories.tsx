import type { Meta, StoryObj } from "@storybook/react-vite";

import { ConnectionRowShared } from "./ConnectionRowShared";

const meta = {
  component: ConnectionRowShared,
  decorators: [(Story) => <div className="w-[488px]"><Story /></div>],
  parameters: { pencil: { componentId: "n7RtBO", groupId: "q9bzl" } },
  title: "Onboarding/Connection Row/Shared",
} satisfies Meta<typeof ConnectionRowShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
