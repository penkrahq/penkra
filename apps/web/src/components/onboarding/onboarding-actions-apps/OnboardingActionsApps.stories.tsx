import type { Meta, StoryObj } from "@storybook/react-vite";

import { OnboardingActionsApps } from "./OnboardingActionsApps";

const meta = {
  component: OnboardingActionsApps,
  decorators: [(Story) => <div className="w-[488px]"><Story /></div>],
  parameters: { pencil: { componentId: "KRsgn", groupId: "q9bzl" } },
  title: "Onboarding/Onboarding Actions/Apps",
} satisfies Meta<typeof OnboardingActionsApps>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
