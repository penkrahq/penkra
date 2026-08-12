import type { Meta, StoryObj } from "@storybook/react-vite";

import { HarnessSelectorShared } from "./HarnessSelectorShared";

const meta = {
  component: HarnessSelectorShared,
  parameters: { pencil: { componentId: "g1dQ5", groupId: "kVpYl" } },
  title: "Middle Panel/Harness Selector/Shared",
} satisfies Meta<typeof HarnessSelectorShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Claude: Story = {};
export const ChatGPTHigh: Story = {
  args: { label: "ChatGPT", provider: "codex", variantLabel: "High" },
};
