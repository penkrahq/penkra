import type { Meta, StoryObj } from "@storybook/react-vite";

import { FieldGroupApiKey } from "./FieldGroupApiKey";

const meta = {
  component: FieldGroupApiKey,
  parameters: {
    pencil: {
      componentId: "YzDKb",
      focusInputId: "PCHyj/nd2S5",
      groupId: "q9bzl",
    },
  },
  title: "Onboarding/Field Group/API Key",
} satisfies Meta<typeof FieldGroupApiKey>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
