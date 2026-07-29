import type { Meta, StoryObj } from "@storybook/react-vite";
import { IconMail, IconSearch } from "@tabler/icons-react";

import { InputShared } from "./InputShared";

const meta = {
  args: {
    "aria-label": "API key",
    leadingIcon: (
      <svg
        aria-hidden="true"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        viewBox="0 0 24 24"
      >
        <circle cx="7.5" cy="15.5" r="5.5" />
        <path d="m12 12 9-9m-3 3 3 3m-6 0 3 3" />
      </svg>
    ),
    placeholder: "sk-ant-••••••••••••••••",
    type: "password",
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

export const Email: Story = {
  args: {
    "aria-label": "Email address",
    leadingIcon: <IconMail aria-hidden className="size-4" />,
    placeholder: "you@company.com",
    type: "email",
  },
};

export const Focused: Story = {
  play: async ({ canvas }) => {
    await canvas.getByLabelText("API key").focus();
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
