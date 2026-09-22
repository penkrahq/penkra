// FILE: ComposerExtrasMenu.tsx
// Purpose: Opens the composer file picker directly from the `+` attachment button.
// Layer: Chat composer presentation
// Depends on: shared button and tooltip primitives plus caller-owned attachment state.

import { useId, useRef, type ChangeEvent } from "react";

import { PlusIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ComposerExtrasMenu = function ComposerExtrasMenu(props: {
  onAddAttachments: (files: File[]) => void;
}) {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Reset the hidden input so selecting the same files twice still emits a change event.
  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) {
      props.onAddAttachments(files);
    }
    event.target.value = "";
  };

  return (
    <>
      <input
        id={inputId}
        ref={fileInputRef}
        data-testid="composer-file-input"
        type="file"
        multiple
        tabIndex={-1}
        className="sr-only"
        onChange={handleFileInputChange}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="!size-[26px] shrink-0 rounded-full p-0 sm:!size-[26px]"
              aria-label="Attach files"
              onClick={() => fileInputRef.current?.click()}
            />
          }
        >
          <PlusIcon aria-hidden="true" className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="top">Attach files</TooltipPopup>
      </Tooltip>
    </>
  );
};
