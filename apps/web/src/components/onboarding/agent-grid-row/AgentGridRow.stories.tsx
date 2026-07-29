import type { Meta, StoryObj } from "@storybook/react-vite";

import { AgentCardClaude } from "../agent-card-claude/AgentCardClaude";
import { AgentCardCodex } from "../agent-card-codex/AgentCardCodex";
import { AgentCardCursor } from "../agent-card-cursor/AgentCardCursor";
import { AgentGridRow } from "./AgentGridRow";

const meta = {
  component: AgentGridRow,
  parameters: { pencil: { componentId: "cnSNP", groupId: "q9bzl" } },
  title: "Onboarding/Agent Grid Row",
} satisfies Meta<typeof AgentGridRow>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {
  args: {
    children: (
      <>
        <AgentCardClaude selected />
        <AgentCardCodex />
        <AgentCardCursor />
      </>
    ),
  },
};
