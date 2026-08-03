import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TopBarThread } from "./TopBarThread";

describe("TopBarThread", () => {
  it("does not render the removed generic panel toggle beneath the Apps launcher", () => {
    const markup = renderToStaticMarkup(
      <TopBarThread harness="claudeAgent" pinned title="Initial greeting" />,
    );

    expect(markup).toContain("Initial greeting");
    expect(markup).toContain('data-slot="thread-identity"');
    expect(markup).toContain('data-provider="claudeAgent"');
    expect(markup).toContain('data-slot="pin-badge"');
    expect(markup).not.toContain("tabler-icon-folder");
    expect(markup).not.toContain("Restore left rail");
    expect(markup).not.toContain("Toggle panel");
  });

  it("replaces the thread identity with the left-rail restore control when collapsed", () => {
    const markup = renderToStaticMarkup(
      <TopBarThread leftRailCollapsed title="Initial greeting" />,
    );

    expect(markup).toContain("Restore left rail");
    expect(markup).toContain('data-slot="left-rail-restore"');
    expect(markup).toContain("sidebar-simple-left-wide.svg");
    expect(markup).not.toContain('data-slot="thread-identity"');
  });
});
