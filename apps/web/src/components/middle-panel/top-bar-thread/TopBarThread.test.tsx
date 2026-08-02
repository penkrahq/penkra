import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TopBarThread } from "./TopBarThread";

describe("TopBarThread", () => {
  it("does not render the removed generic panel toggle beneath the Apps launcher", () => {
    const markup = renderToStaticMarkup(<TopBarThread title="Initial greeting" />);

    expect(markup).toContain("Initial greeting");
    expect(markup).not.toContain("Toggle panel");
  });
});
