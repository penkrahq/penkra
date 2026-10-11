import { ThreadId, type ProviderKind } from "@penkra/contracts";

import { SurfaceTabChip } from "~/components/chat/chatHeaderControls";
import { ThreadIdentityShared } from "~/components/middle-panel/thread-identity-shared/ThreadIdentityShared";
import {
  WorkStatusShared,
  type WorkStatus,
} from "~/components/left-rail/work-status-shared/WorkStatusShared";

export const FOLDER_THREAD_DRAG_TYPE = "penkra/folder-tabs-tab";

export interface FolderThreadDndData {
  readonly type: "folder-tabs-tab";
  readonly folderId: string;
  readonly threadId: ThreadId;
  readonly preview: {
    readonly title: string;
    readonly harness: ProviderKind;
    readonly workStatus: WorkStatus;
  };
}

export function readFolderThreadDndData(value: unknown): FolderThreadDndData | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Partial<FolderThreadDndData>;
  return data.type === "folder-tabs-tab" &&
    typeof data.folderId === "string" &&
    typeof data.threadId === "string" &&
    data.preview !== undefined
    ? (data as FolderThreadDndData)
    : null;
}

export function FolderTabsDragPreview(props: { preview: FolderThreadDndData["preview"] }) {
  return (
    <SurfaceTabChip
      active
      className="shadow-xl"
      icon={
        props.preview.workStatus === "idle" ? (
          <ThreadIdentityShared harness={props.preview.harness} />
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
