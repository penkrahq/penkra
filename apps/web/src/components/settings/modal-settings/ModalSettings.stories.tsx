import type { Meta, StoryObj } from "@storybook/react-vite";

import { ModalSettings } from "./ModalSettings";

const meta = {
  component: ModalSettings,
  parameters: {
    layout: "fullscreen",
    pencil: {
      componentId: "BvoZF",
      groupId: "L8Pc7b",
      relatedIds: ["EigOY", "DaeGT", "H5g0Bs", "d1gb7H", "tyZ7c", "jWlC3"],
      scrollRegionId: "bHQ9w",
    },
  },
  title: "Settings/Modal/Settings",
} satisfies Meta<typeof ModalSettings>;

export default meta;
type Story = StoryObj<typeof meta>;
export const General: Story = {};
export const Appearance: Story = { args: { page: "appearance" } };
