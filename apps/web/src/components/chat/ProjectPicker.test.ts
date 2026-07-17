import { describe, expect, it } from "vitest";

import { projectPickerProjectLabels } from "./ProjectPicker";

describe("projectPickerProjectLabels", () => {
  it("uses Penkra registry names instead of UUID folder names", () => {
    expect(
      projectPickerProjectLabels({
        id: "penkra-client-33333333-3333-4333-8333-333333333333",
        name: "QA Skills Client",
        cwd: "/Users/test/Penkra/33333333-3333-4333-8333-333333333333",
      }),
    ).toEqual({ primaryLabel: "QA Skills Client", secondaryLabel: null });
  });

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
