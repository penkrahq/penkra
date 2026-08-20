import { describe, expect, it } from "vitest";

import { inlineNameEditorErrorMessage } from "./useInlineNameEditor";

describe("inlineNameEditorErrorMessage", () => {
  it("keeps only the actionable detail from an orchestration invariant", () => {
    expect(
      inlineNameEditorErrorMessage(
        new Error(
          "Orchestration command invariant failed (space.create): A space named 'Penkra' already exists.",
        ),
      ),
    ).toBe("A space named 'Penkra' already exists.");
  });

  it("preserves ordinary errors", () => {
    expect(inlineNameEditorErrorMessage(new Error("The app server is unavailable."))).toBe(
      "The app server is unavailable.",
    );
  });
});
