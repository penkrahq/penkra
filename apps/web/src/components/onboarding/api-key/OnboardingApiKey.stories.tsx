import type { Meta, StoryObj } from "@storybook/react-vite";

import { OnboardingApiKey } from "./OnboardingApiKey";

const meta = {
  component: OnboardingApiKey,
  parameters: { layout: "fullscreen", pencil: { componentId: "kCRIp", groupId: "q9bzl" } },
  title: "Onboarding/API Key",
} satisfies Meta<typeof OnboardingApiKey>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
