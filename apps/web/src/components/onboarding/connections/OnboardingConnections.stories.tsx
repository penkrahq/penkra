import type { Meta, StoryObj } from "@storybook/react-vite";

import { OnboardingConnections } from "./OnboardingConnections";

const meta = {
  component: OnboardingConnections,
  parameters: { layout: "fullscreen", pencil: { componentId: "J3rDs", groupId: "q9bzl" } },
  title: "Onboarding/Connections",
} satisfies Meta<typeof OnboardingConnections>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
