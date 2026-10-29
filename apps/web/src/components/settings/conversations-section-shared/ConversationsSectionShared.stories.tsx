import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { ConversationsSectionShared } from "./ConversationsSectionShared";

const meta = {
  component: ConversationsSectionShared,
  title: "Settings/Sections/Conversations",
  args: {
    steerComposer: false,
    steerThreads: false,
    onSteerChange: () => {},
  },
  decorators: [
    (Story) => (
      <div className="max-w-[640px] p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ConversationsSectionShared>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Interactive: Story = {
  render: (args) => {
    const [state, setState] = useState({ composer: false, threads: false });
    return (
      <ConversationsSectionShared
        {...args}
        onSteerChange={(source, enabled) => setState((current) => ({ ...current, [source]: enabled }))}
        steerComposer={state.composer}
        steerThreads={state.threads}
      />
    );
  },
};

export const BothOn: Story = { args: { steerComposer: true, steerThreads: true } };

export const Saving: Story = { args: { steerComposer: true, disabled: true } };
