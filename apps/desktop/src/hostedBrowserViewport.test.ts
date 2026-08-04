import { describe, expect, it } from "vitest";

import { normalizeHostedBrowserViewportBounds } from "./hostedBrowserViewport";

describe("normalizeHostedBrowserViewportBounds", () => {
  it("preserves App-local coordinates instead of translating them into window coordinates", () => {
    expect(
      normalizeHostedBrowserViewportBounds({
        x: 0.4,
        y: 84.4,
        width: 419.6,
        height: 615.6,
      }),
    ).toEqual({ x: 0, y: 84, width: 420, height: 616 });
  });

  it("never forwards negative native view dimensions", () => {
    expect(
      normalizeHostedBrowserViewportBounds({ x: 8, y: 12, width: -1.2, height: -4.8 }),
    ).toEqual({ x: 8, y: 12, width: 0, height: 0 });
  });
});
