import { FolderRowLeading } from "../folder-row-shared/FolderRowShared";
import { InlineRowNameEditor } from "../inline-row-name-editor";

export interface FolderRowInlineEditProps {
  mode?: "create" | "rename";
  defaultValue: string;
  existingNames: ReadonlyArray<string>;
  expanded?: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => Promise<void> | void;
  onValueChange?: (value: string) => void;
  pinned?: boolean;
  value?: string;
}

export function FolderRowInlineEdit(props: FolderRowInlineEditProps) {
  const mode = props.mode ?? "rename";
  return (
    <InlineRowNameEditor
      ariaLabel={mode === "create" ? "New folder name" : "Rename folder"}
      cancelWhenEmpty={mode === "create"}
      defaultValue={props.defaultValue}
      existingNames={props.existingNames}
      leading={
        <FolderRowLeading
          {...(props.expanded === undefined ? {} : { expanded: props.expanded })}
          {...(props.pinned === undefined ? {} : { pinned: props.pinned })}
        />
      }
      onCancel={props.onCancel}
      onSubmit={props.onSubmit}
      {...(props.onValueChange === undefined ? {} : { onValueChange: props.onValueChange })}
      pencilComponentId="L1fWoQ"
      {...(mode === "create" ? { placeholder: "New folder" } : {})}
      {...(props.value === undefined ? {} : { value: props.value })}
    />
  );
}
