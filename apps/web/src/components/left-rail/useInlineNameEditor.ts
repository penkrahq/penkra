import { normalizeEntityName } from "@penkra/shared/entityNames";
import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";

export function useInlineNameEditor(input: {
  defaultValue: string;
  emptyError?: string;
  existingNames?: ReadonlyArray<string>;
  onCancel: () => void;
  onSubmit: (name: string) => Promise<void> | void;
  onValueChange?: (value: string) => void;
  value?: string;
}) {
  const [localValue, setLocalValue] = useState(input.defaultValue);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const submittingRef = useRef(false);
  const errorId = useId();

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const blurForOutsideInteraction = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || rootRef.current?.contains(target)) return;
      inputRef.current?.blur();
    };
    document.addEventListener("pointerdown", blurForOutsideInteraction, true);
    return () => document.removeEventListener("pointerdown", blurForOutsideInteraction, true);
  }, []);

  const value = input.value ?? localValue;
  const trimmedValue = value.trim();
  const normalizedValue = normalizeEntityName(value);
  const duplicate = (input.existingNames ?? []).some(
    (name) => normalizeEntityName(name) === normalizedValue,
  );
  const validationError =
    trimmedValue.length === 0
      ? (input.emptyError ?? "Enter a name.")
      : duplicate
        ? "That name is already taken."
        : null;
  const visibleError = submitError ?? (value.length > 0 ? validationError : null);

  const submit = async () => {
    if (validationError || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await input.onSubmit(trimmedValue);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Unable to save this name.");
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return {
    errorId,
    inputRef,
    rootRef,
    onBlur(event: FocusEvent<HTMLInputElement>) {
      if (rootRef.current?.contains(event.relatedTarget)) return;
      void submit();
    },
    onChange(nextValue: string) {
      if (input.value === undefined) setLocalValue(nextValue);
      input.onValueChange?.(nextValue);
      setSubmitError(null);
    },
    onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        input.onCancel();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        void submit();
      }
    },
    submit,
    submitting,
    validationError,
    value,
    visibleError,
  };
}
