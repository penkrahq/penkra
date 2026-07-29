import type { Meta, StoryObj } from "@storybook/react-vite";

import { AgentLogos } from "./AgentLogos";

const meta = {
  component: AgentLogos,
  parameters: { pencil: { componentId: "kWiGM", groupId: "q9bzl" } },
  title: "Onboarding/Agent Logos",
} satisfies Meta<typeof AgentLogos>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
