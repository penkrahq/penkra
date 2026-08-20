import type { ServerConfig } from "@penkra/contracts";

export function createBrowserTestServerConfig(checkedAt: string): ServerConfig {
  return {
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.penkra-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        provider: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt,
      },
    ],
    availableEditors: [],
  };
}

export function createFullscreenTestHost(): HTMLDivElement {
  const host = document.createElement("div");
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    width: "100vw",
    height: "100vh",
    display: "grid",
    overflow: "hidden",
  });
  document.body.append(host);
  return host;
}
