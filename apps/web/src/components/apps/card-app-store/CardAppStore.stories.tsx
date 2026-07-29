import { IconBrandFigma } from "@tabler/icons-react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { CardAppStore } from "./CardAppStore";

const meta = {
  args: {
    description: "Bring design files into a thread for review.",
    icon: <IconBrandFigma />,
    name: "Figma",
    tone: "purple",
  },
  component: CardAppStore,
  parameters: { pencil: { componentId: "fgUwH", groupId: "o1aLe" } },
  title: "Apps/Card/App Store",
} satisfies Meta<typeof CardAppStore>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
