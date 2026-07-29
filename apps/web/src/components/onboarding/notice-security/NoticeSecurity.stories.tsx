import type { Meta, StoryObj } from "@storybook/react-vite";

import { NoticeSecurity } from "./NoticeSecurity";

const meta = {
  component: NoticeSecurity,
  parameters: { pencil: { componentId: "pTOyi", groupId: "q9bzl" } },
  title: "Onboarding/Notice/Security",
} satisfies Meta<typeof NoticeSecurity>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
