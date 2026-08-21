import "../index.css";

import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

type PromptEditorOnChange = (
  nextValue: string,
  nextCursor: number,
  expandedCursor: number,
  cursorAdjacentToMention: boolean,
  terminalContextIds: string[],
) => void;

function promptEditor(
  value: string,
  onChange: PromptEditorOnChange,
  editorRef?: React.Ref<ComposerPromptEditorHandle>,
) {
  return (
    <ComposerPromptEditor
      ref={editorRef}
      value={value}
      cursor={value.length}
      terminalContexts={[]}
      disabled={false}
      placeholder="Do something"
      onRemoveTerminalContext={vi.fn()}
      onChange={onChange}
      onPaste={vi.fn()}
    />
  );
}

function ControlledPromptEditor() {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  return (
    <ComposerPromptEditor
      value={value}
      cursor={cursor}
      terminalContexts={[]}
      disabled={false}
      placeholder="Do something"
      onRemoveTerminalContext={vi.fn()}
      onChange={(nextValue, nextCursor) => {
        setValue(nextValue);
        setCursor(nextCursor);
      }}
      onPaste={vi.fn()}
    />
  );
}

describe("ComposerPromptEditor controlled updates", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("accepts an accessibility-style fill without entering a controlled update loop", async () => {
    const view = await render(<ControlledPromptEditor />);

    try {
      const editor = page.getByTestId("composer-editor");
      await editor.fill("Run pwd, then sleep 5.");
      await expect.element(editor).toHaveTextContent("Run pwd, then sleep 5.");
    } finally {
      await view.unmount();
    }
  });

  it("does not echo a controlled prompt reset back through onChange", async () => {
    const onChange = vi.fn();
    const view = await render(promptEditor("send this", onChange));

    try {
      await view.rerender(promptEditor("", onChange));
      await new Promise((resolve) => window.setTimeout(resolve, 0));

      expect(onChange).not.toHaveBeenCalled();
      expect(document.querySelector<HTMLElement>("[contenteditable='true']")?.textContent).toBe("");
    } finally {
      await view.unmount();
    }
  });

  it("does not treat programmatic focus restoration as composer input", async () => {
    const onChange = vi.fn();
    const editorRef = createRef<ComposerPromptEditorHandle>();
    const view = await render(promptEditor("send this", onChange, editorRef));

    try {
      editorRef.current?.focusAtEnd();
      await view.rerender(promptEditor("", onChange, editorRef));
      editorRef.current?.focusAtEnd();
      await new Promise((resolve) => window.setTimeout(resolve, 0));

      expect(onChange).not.toHaveBeenCalled();
      expect(editorRef.current?.readSnapshot()).toMatchObject({ value: "", cursor: 0 });
    } finally {
      await view.unmount();
    }
  });
});
