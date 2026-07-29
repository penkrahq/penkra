import type { Meta, StoryObj } from "@storybook/react-vite";

import { OnboardingConnectAgent } from "./OnboardingConnectAgent";

const meta = {
  component: OnboardingConnectAgent,
  parameters: { layout: "fullscreen", pencil: { componentId: "X4Yqda", groupId: "q9bzl" } },
  title: "Onboarding/Connect Agent",
} satisfies Meta<typeof OnboardingConnectAgent>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
