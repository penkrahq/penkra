import type { Meta, StoryObj } from "@storybook/react-vite";

import { AgentCardCursor } from "./AgentCardCursor";

const meta = {
  component: AgentCardCursor,
  parameters: { pencil: { componentId: "lzAV8", groupId: "q9bzl" } },
  title: "Onboarding/Agent Card/Cursor",
} satisfies Meta<typeof AgentCardCursor>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Selected: Story = { args: { selected: true } };
