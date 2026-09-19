import { ThreadId, type ProviderKind } from "@penkra/contracts";

import { SurfaceTabChip } from "~/components/chat/chatHeaderControls";
import { ThreadIdentityShared } from "~/components/middle-panel/thread-identity-shared/ThreadIdentityShared";
import {
  WorkStatusShared,
  type WorkStatus,
} from "~/components/left-rail/work-status-shared/WorkStatusShared";

export const DECK_THREAD_DRAG_TYPE = "penkra/thread-deck-tab";

export interface DeckThreadDndData {
  readonly type: "thread-deck-tab";
  readonly deckId: string;
  readonly threadId: ThreadId;
  readonly preview: {
    readonly title: string;
    readonly harness: ProviderKind;
    readonly pinned: boolean;
    readonly workStatus: WorkStatus;
  };
}

export function readDeckThreadDndData(value: unknown): DeckThreadDndData | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Partial<DeckThreadDndData>;
  return data.type === "thread-deck-tab" &&
    typeof data.deckId === "string" &&
    typeof data.threadId === "string" &&
    data.preview !== undefined
    ? (data as DeckThreadDndData)
    : null;
}

export function ThreadDeckDragPreview(props: { preview: DeckThreadDndData["preview"] }) {
  return (
    <SurfaceTabChip
      active
      className="shadow-xl"
      icon={
        props.preview.workStatus === "idle" ? (
          <ThreadIdentityShared harness={props.preview.harness} pinned={props.preview.pinned} />
        ) : (
          <WorkStatusShared status={props.preview.workStatus} />
        )
      }
      label={props.preview.title}
      labelClassName="max-w-44"
      title={props.preview.title}
    />
  );
}
