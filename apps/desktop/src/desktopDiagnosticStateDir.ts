import * as path from "node:path";

/** Matches the backend's devUrl-based state selection, even in Dev without Vite. */
export function desktopDiagnosticStateDir(baseDir: string, hasDevServerUrl: boolean): string {
  return path.join(baseDir, hasDevServerUrl ? "dev" : "userdata");
}
