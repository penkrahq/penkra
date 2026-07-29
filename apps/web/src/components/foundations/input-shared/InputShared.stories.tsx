import type { Meta, StoryObj } from "@storybook/react-vite";
import { IconMail, IconSearch } from "@tabler/icons-react";

import { InputShared } from "./InputShared";

const meta = {
  args: {
    "aria-label": "Email address",
    leadingIcon: <IconMail aria-hidden className="size-4" />,
    placeholder: "you@company.com",
    type: "email",
  },
  component: InputShared,
  decorators: [
    (Story) => (
      <div className="w-[488px] max-w-[calc(100vw-3rem)]">
        <Story />
      </div>
    ),
  ],
  parameters: {
    pencil: {
      componentId: "AGrUr",
      groupId: "fVh0u",
    },
  },
  title: "Foundations/Input Shared",
} satisfies Meta<typeof InputShared>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Search: Story = {
  args: {
    "aria-label": "Search",
    leadingIcon: <IconSearch aria-hidden className="size-4" />,
    placeholder: "Search",
    type: "search",
  },
};

export const Invalid: Story = {
  args: {
    invalid: true,
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
  },
};
