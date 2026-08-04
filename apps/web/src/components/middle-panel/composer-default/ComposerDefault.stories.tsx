import type { Meta, StoryObj } from "@storybook/react-vite";

import { ComposerDefault } from "./ComposerDefault";

const meta = {
  component: ComposerDefault,
  decorators: [
    (Story) => (
      <div className="w-[640px]">
        <Story />
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "TKKOp", groupId: "kVpYl" } },
  title: "Middle Panel/Composer/Default",
} satisfies Meta<typeof ComposerDefault>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const Filled: Story = { args: { defaultValue: "Continue with the implementation." } };
export const WithoutModelSelector: Story = { args: { showHarness: false } };
