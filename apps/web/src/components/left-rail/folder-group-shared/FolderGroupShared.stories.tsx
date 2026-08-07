import type { Meta, StoryObj } from "@storybook/react-vite";

import { FolderGroupShared } from "./FolderGroupShared";

const threads = [
  { id: "main", label: "Main", provider: "codex" as const, state: "active" as const },
  { id: "metrics", label: "Analyze PostHog metrics", provider: "claudeAgent" as const },
  { id: "search", label: "Add user to Search Console", provider: "codex" as const },
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
export const ClosedRunning: Story = {
  args: { defaultExpanded: false, workStatus: "running" },
};
export const ClosedDone: Story = {
  args: { defaultExpanded: false, workStatus: "done" },
};
export const ClosedNeedsAttention: Story = {
  args: { defaultExpanded: false, workStatus: "attention" },
};
export const ClosedRecording: Story = {
  args: { defaultExpanded: false, workStatus: "recording" },
};
export const Pinned: Story = {
  args: {
    label: "Pinned folder",
    pinned: true,
    threads: threads.map((thread, index) => (index === 0 ? { ...thread, pinned: true } : thread)),
  },
  parameters: { pencil: { componentId: "D2SV3", pinBadgeComponentId: "dTHsB" } },
};
export const Running: Story = {
  args: {
    threads: threads.map((thread, index) =>
      index === 1 ? { ...thread, workStatus: "running" as const } : thread,
    ),
  },
};
export const Done: Story = {
  args: {
    threads: threads.map((thread, index) =>
      index === 1 ? { ...thread, workStatus: "done" as const } : thread,
    ),
  },
};
export const NeedsAttention: Story = {
  args: {
    threads: threads.map((thread, index) =>
      index === 1 ? { ...thread, workStatus: "attention" as const } : thread,
    ),
  },
};
export const Recording: Story = {
  args: {
    threads: threads.map((thread, index) =>
      index === 1 ? { ...thread, workStatus: "recording" as const } : thread,
    ),
  },
};
