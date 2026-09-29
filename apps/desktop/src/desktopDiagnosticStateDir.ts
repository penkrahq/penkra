import * as path from "node:path";

/** Matches the embedded backend's state directory for each desktop flavor. */
export function desktopDiagnosticStateDir(baseDir: string, isDevelopment: boolean): string {
  return path.join(baseDir, isDevelopment ? "dev" : "userdata");
}
