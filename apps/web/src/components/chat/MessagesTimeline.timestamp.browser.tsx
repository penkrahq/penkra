import "../../index.css";
import { ThreadId, TurnId, type CleanCoreThreadItem } from "@penkra/contracts";
import { useState } from "react";
import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MessagesTimeline } from "./MessagesTimeline";
import { threadItemToChatMessage } from "./threadItemMappers";

const turnId = TurnId.makeUnsafe("timestamp-turn");
const marker: CleanCoreThreadItem = {
  threadId: ThreadId.makeUnsafe("timestamp-thread"),
  seq: 1,
  sourceId: "turn:timestamp-turn",
  turnId,
  kind: "turn",
  status: "running",
  text: null,
  data: '{"startedAt":"2026-10-23T05:55:00Z"}',
  createdAt: "2026-10-23T05:55:00Z",
  updatedAt: "2026-10-23T05:55:00Z",
};
const final: CleanCoreThreadItem = {
  ...marker,
  seq: 2,
  sourceId: "answer",
  kind: "text",
  status: "done",
  text: "Writing the trigger contract.",
  data: null,
};

function TimestampTimeline() {
  const [done, setDone] = useState(false);
  return (
    <div style={{ width: 320 }}>
      <button type="button" onClick={() => setDone(true)}>
        Finish turn
      </button>
      <div style={{ height: 240 }}>
        <MessagesTimeline
          hasMessages
          isWorking={!done}
          activeTurnInProgress={!done}
          activeTurnId={turnId}
          activeTurnStartedAt={null}
          turns={{ [turnId]: { ...marker, status: done ? "done" : "running" } }}
          finals={{ [turnId]: final }}
          timelineEntries={
            done
              ? []
              : [
                  {
                    kind: "message",
                    id: final.sourceId,
                    createdAt: final.createdAt,
                    message: threadItemToChatMessage(final),
                  },
                ]
          }
          nowIso="2026-10-23T05:56:00Z"
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="dark"
          timestampFormat="locale"
          workspaceRoot={undefined}
        />
      </div>
    </div>
  );
}

it("shows the assistant timestamp only after its running turn settles", async () => {
  const screen = await render(<TimestampTimeline />);
  try {
    await expect
      .element(page.getByText("Writing the trigger contract.", { exact: true }))
      .toBeVisible();
    expect(screen.container.querySelector(".tabular-nums")).toBeNull();
    await page.screenshot({
      element: screen.container,
      path: "../../../../../.penkra/scratch/attachment-media/timestamp-running.png",
    });
    await page.getByRole("button", { name: "Finish turn" }).click();
    await expect
      .poll(() => screen.container.querySelector(".tabular-nums")?.textContent)
      .toBeTruthy();
    await page.getByText("Writing the trigger contract.", { exact: true }).hover();
    await page.screenshot({
      element: screen.container,
      path: "../../../../../.penkra/scratch/attachment-media/timestamp-settled.png",
    });
  } finally {
    await screen.unmount();
  }
});
