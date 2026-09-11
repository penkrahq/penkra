import "../../index.css";

import { MessageId, TurnId } from "@penkra/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { deriveTimelineEntries } from "../../session-logic";
import { MessagesTimeline } from "./MessagesTimeline";

type TimelineEntries = ReturnType<typeof deriveTimelineEntries>;
type EditHandler = (messageId: MessageId, text: string) => Promise<boolean>;

function EditSettlementTimeline(props: { readonly onEdit: EditHandler }) {
  const [deliverySequence, setDeliverySequence] = useState(11);
  const [mounted, setMounted] = useState(true);
  const [pendingEdit, setPendingEdit] = useState<{
    messageId: MessageId;
    text: string;
    priorDeliverySequence: number;
  } | null>(null);
  const entries: TimelineEntries = [
    {
      id: "entry-edit-target",
      kind: "message",
      createdAt: "2026-09-11T15:38:47.994Z",
      message: {
        id: MessageId.makeUnsafe("message-edit-target"),
        role: "user",
        text: "Original prompt",
        delivery: { state: "accepted", queued: false, sequence: deliverySequence },
        createdAt: "2026-09-11T15:38:47.994Z",
        streaming: false,
      },
    },
    {
      id: "entry-edit-target-assistant",
      kind: "message",
      createdAt: "2026-09-11T15:38:48.000Z",
      message: {
        id: MessageId.makeUnsafe("message-edit-target-assistant"),
        role: "assistant",
        text: "",
        turnId: TurnId.makeUnsafe("turn-edit-target"),
        createdAt: "2026-09-11T15:38:48.000Z",
        streaming: false,
      },
    },
  ];
  return (
    <div>
      <button type="button" onClick={() => setDeliverySequence(13)}>
        Apply replacement delivery
      </button>
      <button type="button" onClick={() => setMounted((value) => !value)}>
        Toggle timeline
      </button>
      <div style={{ height: 420 }}>
        {mounted ? (
          <MessagesTimeline
            hasMessages
            isWorking={false}
            activeTurnInProgress={false}
            activeTurnStartedAt={null}
            timelineEntries={entries}
            nowIso="2026-09-11T15:38:48.000Z"
            expandedWorkGroups={{}}
            onToggleWorkGroup={() => {}}
            onImageExpand={() => {}}
            onEditUserMessage={async (messageId, text) => {
              const admitted = await props.onEdit(messageId, text);
              if (admitted) setPendingEdit({ messageId, text, priorDeliverySequence: 11 });
              return admitted;
            }}
            pendingEditedUserMessage={pendingEdit}
            onClearPendingEditedUserMessage={() => setPendingEdit(null)}
            markdownCwd={undefined}
            resolvedTheme="dark"
            timestampFormat="locale"
            workspaceRoot={undefined}
          />
        ) : null}
      </div>
    </div>
  );
}

describe("message edit delivery settlement", () => {
  it("keeps the editor open after command admission and closes on replacement delivery", async () => {
    const onEdit = vi.fn().mockResolvedValue(true);
    const screen = await render(<EditSettlementTimeline onEdit={onEdit} />);

    await screen.getByRole("button", { name: "Edit message" }).click();
    const editor = screen.getByRole("textbox", { name: "Edit message" });
    await editor.fill("Edited prompt");
    await screen.getByRole("button", { name: "Send" }).click();

    await expect.poll(() => onEdit.mock.calls.length).toBe(1);
    await expect.element(editor).toBeInTheDocument();

    await screen.getByRole("button", { name: "Apply replacement delivery" }).click();
    await expect.element(editor).not.toBeInTheDocument();
  });

  it("retains an admitted edit across timeline remount", async () => {
    const onEdit = vi.fn().mockResolvedValue(true);
    const screen = await render(<EditSettlementTimeline onEdit={onEdit} />);

    await screen.getByRole("button", { name: "Edit message" }).click();
    await screen.getByRole("textbox", { name: "Edit message" }).fill("Edited across remount");
    await screen.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => onEdit.mock.calls.length).toBe(1);

    await screen.getByRole("button", { name: "Toggle timeline" }).click();
    await screen.getByRole("button", { name: "Toggle timeline" }).click();

    const editor = screen.getByRole("textbox", { name: "Edit message" });
    await expect.element(editor).toBeInTheDocument();
    await expect.element(editor).toHaveValue("Edited across remount");
  });
});
