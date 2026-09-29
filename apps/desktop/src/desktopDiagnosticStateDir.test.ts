import { describe, expect, it } from "vitest";
import { desktopDiagnosticStateDir } from "./desktopDiagnosticStateDir";

describe("desktopDiagnosticStateDir", () => {
  it("shares the Dev backend state directory", () => {
    expect(desktopDiagnosticStateDir("/tmp/qa/.penkra", true)).toBe("/tmp/qa/.penkra/dev");
  });

  it("shares the packaged backend state directory", () => {
    expect(desktopDiagnosticStateDir("/tmp/qa/.penkra", false)).toBe("/tmp/qa/.penkra/userdata");
  });

  it("uses the backend userdata directory for a Dev build without Vite", () => {
    const devUrl: string | undefined = undefined;
    expect(desktopDiagnosticStateDir("/tmp/qa/.penkra", devUrl !== undefined)).toBe(
      "/tmp/qa/.penkra/userdata",
    );
  });
});
