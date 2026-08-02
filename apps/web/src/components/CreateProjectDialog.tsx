// FILE: CreateProjectDialog.tsx
// Purpose: Creates a pathless virtual folder inside a Space.

import type { SpaceId } from "@penkra/contracts";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { toSpaceIconName } from "../lib/spaceGrouping";
import { createSpace } from "../lib/spaces";
import { readNativeApi } from "../nativeApi";
import type { Space } from "../types";
import { cn } from "~/lib/utils";
import { CentralIcon } from "~/lib/central-icons";

import { FolderClosed } from "./FolderClosed";
import { SpaceHeaderInlineEdit } from "./left-rail/space-header-inline-edit/SpaceHeaderInlineEdit";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  dialogFieldLabelClassName,
} from "./ui/dialog";
import { ComposerPickerSelectPopup } from "./chat/ComposerPickerMenuPopup";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import { Select, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

const fieldControlClassName = "h-9 rounded-lg border-foreground/12";

export interface CreateProjectSubmitValue {
  readonly name: string;
  readonly spaceId: SpaceId;
}

export function CreateProjectDialog(props: {
  open: boolean;
  spaces: ReadonlyArray<Space>;
  activeSpaceId: SpaceId | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: CreateProjectSubmitValue) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [selectedSpaceKey, setSelectedSpaceKey] = useState<string>("");
  const [spaceEditorOpen, setSpaceEditorOpen] = useState(false);
  const [createdSpace, setCreatedSpace] = useState<Space | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const openedRef = useRef(false);
  const fieldId = useId();
  const nameInputId = `${fieldId}-name`;
  const spaceLabelId = `${fieldId}-space`;
  const errorId = `${fieldId}-error`;

  useEffect(() => {
    if (props.open === openedRef.current) return;
    openedRef.current = props.open;
    if (!props.open) return;
    setName("");
    const activeSpaceExists = props.spaces.some((space) => space.id === props.activeSpaceId);
    setSelectedSpaceKey(activeSpaceExists && props.activeSpaceId ? props.activeSpaceId : "");
    setSpaceEditorOpen(false);
    setCreatedSpace(null);
    setSubmitting(false);
    setFormError(null);
    const frame = requestAnimationFrame(() => document.getElementById(nameInputId)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [nameInputId, props.activeSpaceId, props.open, props.spaces]);

  const spaces =
    createdSpace && !props.spaces.some((space) => space.id === createdSpace.id)
      ? [...props.spaces, createdSpace]
      : props.spaces;
  const selectedSpace = spaces.find((space) => space.id === selectedSpaceKey) ?? null;

  const submit = async () => {
    if (submitting) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("Enter a folder name.");
      return;
    }
    if (!selectedSpace) {
      setFormError("Choose a Space before creating the folder.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await props.onSubmit({ name: trimmedName, spaceId: selectedSpace.id });
      props.onOpenChange(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Unable to create the folder.");
      setSubmitting(false);
    }
  };

  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void submit();
  };

  const handleCreateSpace = async (spaceName: string) => {
    const api = readNativeApi();
    if (!api) throw new Error("The app server is unavailable.");
    const icon = toSpaceIconName("folder");
    const { spaceId } = await createSpace({ api, name: spaceName, icon });
    const createdAt = new Date().toISOString();
    setCreatedSpace({
      id: spaceId,
      name: spaceName,
      icon,
      sortOrder: Number.MAX_SAFE_INTEGER,
      createdAt,
      updatedAt: createdAt,
    });
    setSelectedSpaceKey(spaceId);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup>
        <DialogHeader className="px-5 pt-5">
          <DialogTitle>New folder</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-4 px-5 pt-4">
          <InputGroup className={fieldControlClassName}>
            <InputGroupAddon className="w-10 self-stretch border-e border-foreground/12 ps-0">
              <FolderClosed className="size-4 text-muted-foreground/70" aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              id={nameInputId}
              value={name}
              aria-label="Folder name"
              aria-invalid={formError ? true : undefined}
              {...(formError ? { "aria-describedby": errorId } : {})}
              placeholder="Folder name"
              onChange={(event) => {
                setName(event.target.value);
                setFormError(null);
              }}
              onKeyDown={submitOnEnter}
            />
          </InputGroup>

          <div className="space-y-2">
            <span id={spaceLabelId} className={cn("block", dialogFieldLabelClassName)}>
              Space
            </span>
            <div className="flex items-center gap-2">
              <Select
                value={selectedSpaceKey}
                onValueChange={(value) => setSelectedSpaceKey(value ?? "")}
              >
                <SelectTrigger
                  aria-labelledby={spaceLabelId}
                  className={cn(fieldControlClassName, "min-w-0 flex-1")}
                >
                  <SelectValue>{selectedSpace?.name ?? "Choose a Space"}</SelectValue>
                </SelectTrigger>
                <ComposerPickerSelectPopup align="start">
                  {spaces.map((space) => (
                    <SelectItem key={space.id} value={space.id}>
                      {space.name}
                    </SelectItem>
                  ))}
                </ComposerPickerSelectPopup>
              </Select>
              <Button
                variant="outline"
                size="icon"
                aria-label="New space"
                disabled={submitting}
                className={cn(fieldControlClassName, "w-9 shrink-0 sm:h-9")}
                onClick={() => setSpaceEditorOpen(true)}
              >
                <CentralIcon name="plus-medium" className="size-4" aria-hidden="true" />
              </Button>
            </div>
            {spaceEditorOpen ? (
              <SpaceHeaderInlineEdit
                accessibleHeading="New space"
                className="mt-2"
                existingNames={spaces.map((space) => space.name)}
                inputLabel="Name"
                mode="create"
                onCancel={() => setSpaceEditorOpen(false)}
                onSubmit={async (spaceName) => {
                  await handleCreateSpace(spaceName);
                  setSpaceEditorOpen(false);
                }}
                submitLabel="Create space"
              />
            ) : null}
          </div>

          {formError ? (
            <p id={errorId} role="alert" className="text-xs text-destructive">
              {formError}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter className="px-5 pb-5">
          <Button
            variant="ghost"
            shape="capsule"
            onClick={() => props.onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button shape="capsule" onClick={() => void submit()} disabled={submitting}>
            {submitting ? "Creating…" : "Create folder"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
