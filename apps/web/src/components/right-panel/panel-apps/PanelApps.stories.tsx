import type { Meta, StoryObj } from "@storybook/react-vite";

import { PanelApps } from "./PanelApps";

const meta = {
  component: PanelApps,
  parameters: {
    layout: "fullscreen",
    pencil: { componentId: "nT768", groupId: "DH1W8", relatedId: "ayA7J" },
  },
  title: "Right Panel/Panel/Apps",
} satisfies Meta<typeof PanelApps>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
