import type { Meta, StoryObj } from "@storybook/react-vite";

import { OnboardingApps } from "./OnboardingApps";

const meta = {
  component: OnboardingApps,
  parameters: {
    layout: "fullscreen",
    pencil: {
      componentId: "YmEq2",
      groupId: "q9bzl",
      nestedComponents: {
        actions: "KRsgn",
        appGrid: "lHJt3",
        search: "Q9f3R9",
      },
    },
  },
  render: (args) => (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-background-surface)] p-0">
      <OnboardingApps {...args} />
    </main>
  ),
  title: "Onboarding/Apps",
} satisfies Meta<typeof OnboardingApps>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
