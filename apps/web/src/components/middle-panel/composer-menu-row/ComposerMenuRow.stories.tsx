import { IconSparkles } from "@tabler/icons-react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { ComposerMenuRow } from "./ComposerMenuRow";

const meta = {
  args: { children: "Codex", leading: <IconSparkles /> },
  component: ComposerMenuRow,
  decorators: [
    (Story) => (
      <div className="w-[206px]">
        <Story />
      </div>
    ),
  ],
  parameters: {
    pencil: { componentId: "pbUT3", groupId: "kVpYl", relatedId: "nBV5e" },
  },
  title: "Middle Panel/Composer Menu Row",
} satisfies Meta<typeof ComposerMenuRow>;

export default meta;
type Story = StoryObj<typeof meta>;
export const WithIcon: Story = {};
export const TextOnly: Story = { args: { children: "Claude Haiku 4.5", leading: undefined } };
