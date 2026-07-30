import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { Button } from "~/components/ui/button";

import { PopupLogoutConfirmation } from "./PopupLogoutConfirmation";

function PopupLogoutConfirmationStory() {
  const [open, setOpen] = useState(true);

  return (
    <>
      <Button onClick={() => setOpen(true)}>Open logout confirmation</Button>
      <PopupLogoutConfirmation
        onConfirm={() => Promise.resolve()}
        onOpenChange={setOpen}
        open={open}
      />
    </>
  );
}

const meta = {
  component: PopupLogoutConfirmationStory,
  parameters: {
    layout: "fullscreen",
    pencil: { componentId: "hSE1M", exampleId: "E0ga9", groupId: "PUf7t" },
  },
  title: "Left Rail/Popup/Logout Confirmation",
} satisfies Meta<typeof PopupLogoutConfirmationStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
