import type { Meta, StoryObj } from "@storybook/react-vite";

import { PresentedMediaRow } from "./PresentedMediaRow";

// Attachment ids point at the local server, so images load only with one running; the layout shows either way.
const items = [1, 2, 3].map((n) => ({
  attachmentId: `story-image-${n}`,
  name: `photo-${n}.png`,
  mimeType: "image/png",
  sizeBytes: 120_000,
  type: "image" as const,
}));

const meta = {
  component: PresentedMediaRow,
  title: "Chat/Presented Media",
  args: { items, onImageExpand: () => {} },
  decorators: [
    (Story) => (
      <div className="flex w-[640px] flex-col p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PresentedMediaRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Assistant media, on the left of the thread: strip on the right. */
export const FromAssistant: Story = {};

/** The user's own message, on the right: mirrored, strip on the left. */
export const FromUser: Story = { args: { align: "end" } };
