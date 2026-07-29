import type { Meta, StoryObj } from "@storybook/react-vite";

import { OnboardingWelcome } from "./OnboardingWelcome";

const meta = {
  component: OnboardingWelcome,
  parameters: { layout: "fullscreen", pencil: { componentId: "X3BOc", groupId: "q9bzl" } },
  title: "Onboarding/Welcome",
} satisfies Meta<typeof OnboardingWelcome>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
