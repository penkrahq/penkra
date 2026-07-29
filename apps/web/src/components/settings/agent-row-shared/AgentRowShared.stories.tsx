import type { Meta, StoryObj } from "@storybook/react-vite";

import { AgentRowShared } from "./AgentRowShared";

const meta = {
  component: AgentRowShared,
  decorators: [(Story) => <div className="w-[440px]"><Story /></div>],
  parameters: { pencil: { componentId: "Ow8Yz", groupId: "L8Pc7b" } },
  title: "Settings/Agent Row/Shared",
} satisfies Meta<typeof AgentRowShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Claude: Story = {};
export const Codex: Story = { args: { label: "Codex", provider: "codex" } };
