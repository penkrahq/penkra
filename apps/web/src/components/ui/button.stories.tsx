import type { Meta, StoryObj } from "@storybook/react-vite";
import { IconArrowRight, IconSettings } from "@tabler/icons-react";

import { Button } from "./button";

const meta = {
  args: {
    children: "Continue",
  },
  argTypes: {
    shape: {
      control: "inline-radio",
      options: ["default", "capsule"],
    },
    size: {
      control: "select",
      options: ["chip", "xs", "sm", "default", "lg", "xl"],
    },
    variant: {
      control: "select",
      options: [
        "default",
        "secondary",
        "outline",
        "primary-outline",
        "secondary-outline",
        "destructive",
        "destructive-outline",
        "ghost",
        "subtle",
        "chrome",
        "chrome-outline",
        "prominent",
        "link",
      ],
    },
  },
  component: Button,
  parameters: {
    docs: {
      description: {
        component:
          "The shared desktop button foundation. Primary and secondary correspond to Pencil nodes TecAX and LsMFv within the fVh0u foundations group; the remaining stories document variants already supported by the production component.",
      },
    },
    pencil: {
      groupId: "fVh0u",
      variants: {
        primary: "TecAX",
        secondary: "LsMFv",
      },
    },
  },
  title: "Foundations/Button",
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {};

export const Secondary: Story = {
  args: {
    variant: "secondary",
  },
};

export const Outline: Story = {
  args: {
    variant: "outline",
  },
};

export const Destructive: Story = {
  args: {
    children: "Delete",
    variant: "destructive",
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
  },
};

export const WithIcon: Story = {
  args: {
    children: (
      <>
        Continue
        <IconArrowRight aria-hidden />
      </>
    ),
  },
};

export const IconOnly: Story = {
  args: {
    "aria-label": "Open settings",
    children: <IconSettings aria-hidden />,
    size: "icon",
    variant: "ghost",
  },
};
