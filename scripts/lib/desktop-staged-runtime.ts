// FILE: desktop-staged-runtime.ts
// Purpose: Resolves production-only packages that must be removed from staged desktop builds.
// Layer: Release/build helper

export function resolveUnusedClaudePlatformPackageName(
  platform: "mac" | "linux" | "win",
  arch: "arm64" | "universal" | "x64",
): string | null {
  if (arch === "universal") return null;
  const os = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  return `claude-agent-sdk-${os}-${arch}`;
}
