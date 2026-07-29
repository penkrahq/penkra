import type { Meta, StoryObj } from "@storybook/react-vite";

import { MessageAssistant } from "./MessageAssistant";

const meta = {
  args: {
    children:
      "Once approved, I'll read only the production ADMIN_EMAILS value and confirm the exact recipients.",
  },
  component: MessageAssistant,
  decorators: [(Story) => <div className="w-[560px]"><Story /></div>],
  parameters: { pencil: { componentId: "kUqNe", groupId: "e46ib4" } },
  title: "Middle Panel/Message/Assistant",
} satisfies Meta<typeof MessageAssistant>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const WithoutWorkSummary: Story = { args: { workedFor: null } };
