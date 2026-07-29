import { IconBrandChrome } from "@tabler/icons-react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { AppListCard } from "~/components/apps/app-list-card/AppListCard";

import { AppGrid } from "./AppGrid";

const meta = {
  component: AppGrid,
  parameters: { pencil: { componentId: "lHJt3", groupId: "q9bzl" } },
  title: "Onboarding/App Grid",
} satisfies Meta<typeof AppGrid>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {
  args: {
    children: Array.from({ length: 5 }, (_, index) => (
      <AppListCard
        checked={index < 2}
        description="Search the web and pull in pages without leaving your thread."
        icon={<IconBrandChrome className="size-7 text-[#4a90e2]" />}
        key={index}
        name={index ? `App ${index + 1}` : "Browser"}
        onCheckedChange={() => undefined}
      />
    )),
  },
};
