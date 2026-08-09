// FILE: entry.ts
// Purpose: Selects the ordinary desktop or the isolated installed-App test host.
// Layer: Electron main-process entrypoint

const internalMode = process.env.PENKRA_INTERNAL_DESKTOP_MODE?.trim();

if (internalMode === "app-test") {
  void import("./appTestHost");
} else {
  void import("./main");
}
