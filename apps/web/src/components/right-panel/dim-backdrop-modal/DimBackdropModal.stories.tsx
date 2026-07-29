import type { Meta, StoryObj } from "@storybook/react-vite";

import { DimBackdropModal } from "./DimBackdropModal";

const meta = {
  component: DimBackdropModal,
  decorators: [
    (Story) => (
      <div className="relative h-80 w-[520px] bg-[var(--color-background-surface)]">
        <Story />
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "P8HGk", groupId: "DH1W8" } },
  title: "Right Panel/Dim Backdrop/Modal",
} satisfies Meta<typeof DimBackdropModal>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
