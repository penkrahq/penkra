import type { Meta, StoryObj } from "@storybook/react-vite";

import { ModalAppDetail } from "./ModalAppDetail";

const meta = {
  component: ModalAppDetail,
  parameters: { pencil: { componentId: "tmIN8", groupId: "o1aLe" } },
  title: "Apps/Modal/App Detail",
} satisfies Meta<typeof ModalAppDetail>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Figma: Story = {};
