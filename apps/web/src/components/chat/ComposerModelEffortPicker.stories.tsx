import {
  ProviderConnectionId,
  ThreadId,
  type ProviderConnection,
  type ProviderModelDescriptor,
} from "@penkra/contracts";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { useProviderUsage } from "~/providerUsageStore";

import { ComposerConnectionSection } from "./ComposerConnectionControl";
import { ComposerModelEffortPicker } from "./ComposerModelEffortPicker";

const connectionId = ProviderConnectionId.make("story-connection");
const connection = {
  id: connectionId,
  harness: "claudeAgent",
  label: "alex@example.com",
  lifecycle: "active",
  authenticationTargetId: "claude",
  authenticationMethodId: "subscription",
} as unknown as ProviderConnection;

const hours = (count: number) => new Date(Date.now() + count * 3_600_000).toISOString();
useProviderUsage.setState(
  new Map([
    [
      connectionId,
      {
        provider: "claudeAgent",
        connectionId,
        updatedAt: new Date().toISOString(),
        limits: [
          { window: "5h", usedPercent: 25, resetsAt: hours(3.5), windowDurationMins: 300 },
          { window: "Weekly", usedPercent: 2, resetsAt: hours(165), windowDurationMins: 10_080 },
        ],
        usageLines: [],
        source: "story",
      },
    ],
  ]) as never,
  true,
);

const baseModel = {
  slug: "claude-sonnet-5-5",
  name: "Sonnet 5.5",
  supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((value) => ({ value })),
  defaultReasoningEffort: "low",
};
const twoWindows = {
  ...baseModel,
  contextWindowOptions: [
    { value: "200k", label: "Standard" },
    { value: "1m", label: "1M", isDefault: true },
  ],
  defaultContextWindow: "1m",
} as unknown as ProviderModelDescriptor;

const meta = {
  component: ComposerModelEffortPicker,
  title: "Composer/Model Picker",
  args: {
    provider: "claudeAgent",
    model: "claude-sonnet-5-5",
    lockedProvider: null,
    modelOptionsByProvider: {
      claudeAgent: [{ slug: "claude-sonnet-5-5", name: "Sonnet 5.5" }],
      codex: [],
      opencode: [],
    } as never,
    threadId: ThreadId.make("story-thread"),
    modelOptions: undefined,
    prompt: "",
    onPromptChange: () => {},
    onProviderModelChange: () => {},
    runtimeModel: twoWindows,
    runtimeModels: [twoWindows],
    defaultOpen: true,
    renderConnectionSection: (close) => (
      <ComposerConnectionSection
        provider="claudeAgent"
        connections={[connection]}
        selectedConnectionId={connectionId}
        onConnectionChange={() => {}}
        onClose={close}
      />
    ),
  },
  decorators: [
    (Story) => (
      <div className="flex h-[520px] w-[420px] items-end justify-end p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ComposerModelEffortPicker>;

export default meta;
type Story = StoryObj<typeof meta>;
export const WithContextChoice: Story = {};
const oneWindow = {
  ...baseModel,
  contextWindowOptions: [{ value: "1m", label: "1M", isDefault: true }],
  defaultContextWindow: "1m",
} as unknown as ProviderModelDescriptor;
export const OneWindow: Story = { args: { runtimeModel: oneWindow, runtimeModels: [oneWindow] } };
