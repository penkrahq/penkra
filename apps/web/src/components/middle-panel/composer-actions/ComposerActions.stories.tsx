import type { Meta, StoryObj } from "@storybook/react-vite";

import { ComposerActions } from "./ComposerActions";

const meta = {
  component: ComposerActions,
  decorators: [(Story) => <div className="w-[538px]"><Story /></div>],
  parameters: { pencil: { componentId: "JwTiI", groupId: "e46ib4" } },
  title: "Middle Panel/Composer Actions",
} satisfies Meta<typeof ComposerActions>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const WithHarness: Story = { args: { showHarness: true } };
