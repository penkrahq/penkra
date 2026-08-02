import type { Meta, StoryObj } from "@storybook/react-vite";
import { AppBar, PenkraIcon } from "@penkra/ui/react";
import "@penkra/ui/tokens.css";
import "@penkra/ui/app-bar.css";

const meta = {
  title: "App SDK/App Bar",
  component: AppBar,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AppBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Display: Story = {
  args: {
    leading: [
      { key: "back", label: "Back", icon: <PenkraIcon name="back" />, onActivate: () => undefined },
    ],
    center: { kind: "display", text: "staging-family.atferd.com" },
    trailing: [
      { key: "more", label: "More", icon: <PenkraIcon name="more" />, onActivate: () => undefined },
    ],
  },
};

export const AddressInput: Story = {
  args: {
    leading: [
      { key: "back", label: "Back", icon: <PenkraIcon name="back" />, onActivate: () => undefined },
      {
        key: "forward",
        label: "Forward",
        icon: <PenkraIcon name="forward" />,
        onActivate: () => undefined,
      },
    ],
    center: {
      kind: "input",
      value: "",
      placeholder: "Enter a URL",
      label: "Address",
      onValueChange: () => undefined,
    },
    trailing: [
      { key: "more", label: "More", icon: <PenkraIcon name="more" />, onActivate: () => undefined },
    ],
  },
};

export const OmittedPerPage: Story = {
  render: () => (
    <main className="min-h-40 bg-[var(--penkra-background)] p-6 text-[var(--penkra-text-primary)]">
      This page intentionally omits the optional App Bar.
    </main>
  ),
};
