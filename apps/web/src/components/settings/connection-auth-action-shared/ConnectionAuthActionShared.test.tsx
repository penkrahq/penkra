import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ConnectionAuthActionShared } from "./ConnectionAuthActionShared";

describe("ConnectionAuthActionShared", () => {
  it("contrasts the ChatGPT icon with the sign-in button background", () => {
    const markup = renderToStaticMarkup(
      <ConnectionAuthActionShared
        kind="sign-in"
        label="Sign in"
        onClick={vi.fn()}
        provider="codex"
      />,
    );

    expect(markup).toContain("text-[var(--color-background)]");
  });
});
