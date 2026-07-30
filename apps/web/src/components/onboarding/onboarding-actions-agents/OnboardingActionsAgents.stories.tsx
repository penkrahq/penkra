import type { Meta, StoryObj } from "@storybook/react-vite";

import { OnboardingActionsAgents } from "./OnboardingActionsAgents";

const meta = {
  component: OnboardingActionsAgents,
  decorators: [
    (Story) => (
      <div className="w-[488px]">
        <Story />
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "M0qCG", groupId: "q9bzl" } },
  title: "Onboarding/Onboarding Actions/Agents",
} satisfies Meta<typeof OnboardingActionsAgents>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
