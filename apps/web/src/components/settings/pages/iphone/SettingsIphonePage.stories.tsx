import type { Meta, StoryObj } from "@storybook/react-vite";

import { SettingsIphonePage } from "./SettingsIphonePage";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const meta = {
  component: SettingsIphonePage,
  title: "Settings/Pages/iPhone",
  args: {
    onAccessChange: () => {},
    onRemove: () => {},
    onSignInAgain: () => {},
    onCheckForUpdates: () => {},
    relay: { kind: "connected" },
  },
  decorators: [
    (Story) => (
      <div className="max-w-[640px] p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SettingsIphonePage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Paired: Story = {
  args: {
    signedIn: true,
    accessOn: true,
    phones: [
      { deviceId: "p1", name: "Emmanuel's iPhone", connected: true, lastConnectedAt: ago(0) },
      {
        deviceId: "p2",
        name: "Old iPhone 12",
        connected: false,
        lastConnectedAt: ago(60 * 26 * 3),
      },
    ],
  },
};
export const NoPhonesYet: Story = { args: { signedIn: true, accessOn: true, phones: [] } };
export const Off: Story = { args: { signedIn: true, accessOn: false, phones: [] } };
export const SignedOut: Story = { args: { signedIn: false, accessOn: false, phones: [] } };
export const Connecting: Story = {
  args: { signedIn: true, accessOn: true, phones: [], relay: { kind: "connecting" } },
};
export const SignInRejected: Story = {
  args: { signedIn: true, accessOn: true, phones: [], relay: { kind: "rejected-sign-in" } },
};
export const VersionRejected: Story = {
  args: { signedIn: true, accessOn: true, phones: [], relay: { kind: "rejected-version" } },
};
