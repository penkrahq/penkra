import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ThreadIdentityShared } from "./ThreadIdentityShared";

describe("ThreadIdentityShared", () => {
  it("renders the selected provider artwork instead of a generic folder", () => {
    const markup = renderToStaticMarkup(<ThreadIdentityShared harness="opencode" />);

    expect(markup).toContain('data-provider="opencode"');
    expect(markup).toContain("opencode");
    expect(markup).not.toContain("tabler-icon-folder");
  });

  it("overlays the shared pin badge when the thread is pinned", () => {
    const markup = renderToStaticMarkup(<ThreadIdentityShared harness="claudeAgent" pinned />);

    expect(markup).toContain('data-slot="pin-badge"');
  });
});
