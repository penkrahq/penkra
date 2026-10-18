import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ThreadDetailHydrationState } from "./ThreadDetailHydrationState";

it("shows the read failure message and distinguishes a missing conversation", () => {
  const failed = renderToStaticMarkup(
    <ThreadDetailHydrationState
      state="failed"
      error={new Error("Read failed: connection closed")}
      onRetry={() => {}}
    />,
  );
  expect(failed).toContain("Read failed: connection closed");
  expect(failed).toContain("Try again");
  const missing = renderToStaticMarkup(
    <ThreadDetailHydrationState state="missing" onRetry={() => {}} />,
  );
  expect(missing).toContain("This conversation no longer exists.");
  expect(missing).not.toContain("Try again");
});
