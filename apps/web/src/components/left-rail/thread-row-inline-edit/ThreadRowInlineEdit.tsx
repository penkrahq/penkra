import type { ProviderKind } from "@penkra/contracts";

import { InlineRowNameEditor } from "../inline-row-name-editor";
import { ThreadRowLeading, type ThreadRowLevel } from "../thread-row-shared/ThreadRowShared";

export interface ThreadRowInlineEditProps {
  defaultValue: string;
  harness?: ProviderKind | "github";
  level?: ThreadRowLevel;
  onCancel: () => void;
  onSubmit: (name: string) => Promise<void> | void;
  onValueChange?: (value: string) => void;
  pinned?: boolean;
  value?: string;
}

export function ThreadRowInlineEdit({
  defaultValue,
  harness = "claudeAgent",
  level = "root",
  onCancel,
  onSubmit,
  onValueChange,
  pinned = false,
  value,
}: ThreadRowInlineEditProps) {
  return (
    <InlineRowNameEditor
      ariaLabel="Rename thread"
      className={level === "nested" ? "pl-6" : "pl-2.5"}
      defaultValue={defaultValue}
      leading={<ThreadRowLeading harness={harness} pinned={pinned} />}
      onCancel={onCancel}
      onSubmit={onSubmit}
      {...(onValueChange === undefined ? {} : { onValueChange })}
      pencilComponentId="VrNdb"
      {...(value === undefined ? {} : { value })}
    />
  );
}
