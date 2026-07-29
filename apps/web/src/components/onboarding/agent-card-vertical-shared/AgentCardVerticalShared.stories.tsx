import type { Meta, StoryObj } from "@storybook/react-vite";

import { AgentCardVerticalShared } from "./AgentCardVerticalShared";

const meta = {
  component: AgentCardVerticalShared,
  parameters: { pencil: { componentId: "x907Kx", groupId: "q9bzl", statesId: "Yo8ui" } },
  title: "Onboarding/Agent Card Vertical/Shared",
} satisfies Meta<typeof AgentCardVerticalShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Claude: Story = {};
export const CodexSelected: Story = {
  args: { children: "Codex", description: "OpenAI", provider: "codex", selected: true },
};
export const Cursor: Story = {
  args: { children: "Cursor", description: "Cursor", provider: "cursor" },
};
