import type { Meta, StoryObj } from "@storybook/react-vite";

import { IconActionTooltip } from "./IconActionTooltip";

const meta = {
  component: IconActionTooltip,
  parameters: {
    pencil: {
      componentId: "zwljJ",
      groupId: "fVh0u",
      overlayId: "o4UviR",
      tooltipIds: ["Q5AL4", "eH89J"],
    },
  },
  title: "Foundations/Tooltip/Icon Action",
} satisfies Meta<typeof IconActionTooltip>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Closed: Story = {};
export const Open: Story = { args: { defaultOpen: true } };
export const CopyResponse: Story = {
  args: {
    ariaLabel: "Copy response",
    defaultOpen: true,
    label: "Copy response",
    shortcut: "",
  },
};
