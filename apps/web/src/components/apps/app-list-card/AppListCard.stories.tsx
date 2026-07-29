import type { Meta, StoryObj } from "@storybook/react-vite";
import { IconBrandChrome } from "@tabler/icons-react";
import { useArgs } from "storybook/preview-api";

import { AppListCard } from "./AppListCard";

const meta = {
  args: {
    checked: true,
    description: "Search the web and pull in pages without leaving your thread.",
    icon: <IconBrandChrome aria-hidden className="size-7 text-[#4a90e2]" />,
    name: "Browser",
    onCheckedChange: () => undefined,
  },
  component: AppListCard,
  decorators: [
    (Story) => (
      <div className="w-[488px] max-w-[calc(100vw-3rem)]">
        <Story />
      </div>
    ),
  ],
  parameters: {
    pencil: {
      componentId: "oKL7w",
      groupId: "o1aLe",
    },
  },
  render: function Render(args) {
    const [{ checked }, updateArgs] = useArgs();
    return (
      <AppListCard
        {...args}
        checked={Boolean(checked)}
        onCheckedChange={(next) => updateArgs({ checked: next })}
      />
    );
  },
  title: "Apps/App List Card",
} satisfies Meta<typeof AppListCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Selected: Story = {};

export const NotSelected: Story = {
  args: {
    checked: false,
  },
};
