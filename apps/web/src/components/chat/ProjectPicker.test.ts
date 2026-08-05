import { describe, expect, it } from "vitest";

import { projectPickerProjectLabels } from "./ProjectPicker";

describe("projectPickerProjectLabels", () => {
  it("preserves local-name and folder labels for ordinary projects", () => {
    expect(
      projectPickerProjectLabels({
        id: "project-1",
        name: "Repository",
        localName: "Client Portal",
        cwd: "/Users/test/code/client-portal",
      }),
    ).toEqual({ primaryLabel: "Client Portal", secondaryLabel: "client-portal" });
  });
});
