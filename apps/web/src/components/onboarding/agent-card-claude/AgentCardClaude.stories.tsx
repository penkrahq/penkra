import type { Meta, StoryObj } from "@storybook/react-vite";

import { AgentCardClaude } from "./AgentCardClaude";

const meta = {
  component: AgentCardClaude,
  parameters: { pencil: { componentId: "k5hz3", groupId: "q9bzl" } },
  title: "Onboarding/Agent Card/Claude",
} satisfies Meta<typeof AgentCardClaude>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Selected: Story = { args: { selected: true } };
