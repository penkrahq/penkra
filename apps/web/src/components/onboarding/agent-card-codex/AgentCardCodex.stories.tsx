import type { Meta, StoryObj } from "@storybook/react-vite";

import { AgentCardCodex } from "./AgentCardCodex";

const meta = {
  component: AgentCardCodex,
  parameters: { pencil: { componentId: "TC6n2", groupId: "q9bzl" } },
  title: "Onboarding/Agent Card/Codex",
} satisfies Meta<typeof AgentCardCodex>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Selected: Story = { args: { selected: true } };
