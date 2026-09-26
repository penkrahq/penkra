// FILE: ThreadErrorBanner.test.tsx
// Purpose: Guards the thread error banner presentation.
// Layer: Component rendering tests
// Depends on: the banner component and React server rendering.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  it("shows a dismissible error without a manual recovery action", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error="The provider failed." onDismiss={() => {}} />,
    );

    expect(markup).toContain("The provider failed.");
    expect(markup).toContain("Dismiss error");
    expect(markup).not.toContain("Unblock thread");
  });

  it("renders nothing without an error", () => {
    expect(renderToStaticMarkup(<ThreadErrorBanner error={null} />)).toBe("");
  });

  it("keeps a connection authentication error visible with recovery actions and hidden raw detail", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error={
          "The provider is rejecting this Connection. Penkra has paused new turns.\nProvider detail: 401 Incorrect API key provided"
        }
        onDismiss={() => {}}
        onRetry={() => {}}
        onReauthenticate={() => {}}
      />,
    );
    expect(markup).toContain("Retry");
    expect(markup).toContain("Sign in again");
    expect(markup).toContain("<details");
    expect(markup).not.toContain("Dismiss error");
  });
});
