import type { Meta, StoryObj } from "@storybook/react-vite";

import { ModalAppsGallery } from "./ModalAppsGallery";

const meta = {
  component: ModalAppsGallery,
  parameters: {
    layout: "fullscreen",
    pencil: {
      componentId: "WDRTD",
      groupId: "o1aLe",
      scrollRegionId: "ObMlu",
    },
  },
  title: "Apps/Modal/Apps Gallery",
} satisfies Meta<typeof ModalAppsGallery>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
