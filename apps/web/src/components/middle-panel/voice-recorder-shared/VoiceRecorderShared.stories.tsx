import type { Meta, StoryObj } from "@storybook/react-vite";

import { VoiceRecorderShared } from "./VoiceRecorderShared";

const meta = {
  component: VoiceRecorderShared,
  args: {
    durationLabel: "0:08",
    isTranscribing: false,
    onCancel: () => undefined,
    onSubmit: () => undefined,
    waveformLevels: [0.2, 0.55, 0.35, 0.8, 0.45, 0.65, 0.3],
  },
  decorators: [
    (Story) => (
      <div className="w-[420px] p-4">
        <Story />
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "XXuHe" } },
  title: "Middle Panel/Voice Recorder/Shared",
} satisfies Meta<typeof VoiceRecorderShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Recording: Story = {};
export const Transcribing: Story = { args: { isTranscribing: true } };
