import type { Meta, StoryObj } from "@storybook/react-vite";

import { FolderGroupShared } from "./FolderGroupShared";

const threads = [
  { id: "main", label: "Main", provider: "codex" as const, state: "selected" as const },
  { id: "metrics", label: "Analyze PostHog metrics…", provider: "claudeAgent" as const },
  { id: "search", label: "Add user to Search…", provider: "codex" as const },
  { id: "discord", label: "Set up Penut Discord", provider: "cursor" as const },
];

const meta = {
  args: { defaultExpanded: true, showMore: true, threads },
  component: FolderGroupShared,
  decorators: [
    (Story) => (
      <div className="w-56">
        <Story />
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "Shahm", groupId: "PUf7t" } },
  title: "Left Rail/Folder Group/Shared",
} satisfies Meta<typeof FolderGroupShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Open: Story = {};
export const Closed: Story = { args: { defaultExpanded: false } };
