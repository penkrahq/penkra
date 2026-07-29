import type { Meta, StoryObj } from "@storybook/react-vite";

import { IconTileApp } from "./IconTileApp";

const meta = {
  component: IconTileApp,
  parameters: { pencil: { componentId: "hqS2K", groupId: "o1aLe" } },
  title: "Apps/Icon Tile/App",
} satisfies Meta<typeof IconTileApp>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
