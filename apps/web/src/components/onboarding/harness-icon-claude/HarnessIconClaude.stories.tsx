import type { Meta, StoryObj } from "@storybook/react-vite";

import { HarnessIconClaude } from "./HarnessIconClaude";

const meta = {
  component: HarnessIconClaude,
  parameters: { pencil: { componentId: "x4UEfB", groupId: "q9bzl" } },
  title: "Onboarding/Harness Icon/Claude",
} satisfies Meta<typeof HarnessIconClaude>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
