import React from "react";
import { createRoot } from "react-dom/client";
import "../apps/web/src/index.css";
import { SingleChatSurface } from "../apps/web/src/components/chat/SingleChatSurface";
import { SidebarProvider } from "../apps/web/src/components/ui/sidebar";
import { applyFolderAppTabs, useRightDockStore } from "../apps/web/src/rightDockStore";
const seed = await window.desktopBridge.qa.getSeed();
window.qaFolderTabs = seed.folderTabs;
window.qa = {
  setup: async (active: string, open: boolean) => {
    useRightDockStore.getState().setActivePane("qa-folder", active);
    useRightDockStore.getState().setDockOpen("qa-folder", open);
    await new Promise((r) => setTimeout(r, 350));
    return window.qa.state();
  },
  state: () =>
    JSON.parse(JSON.stringify(useRightDockStore.getState().dockStateByFolderId["qa-folder"])),
};
applyFolderAppTabs(seed.folderTabs);
createRoot(document.getElementById("root")!).render(
  <SidebarProvider>
    <div style={{ width: "100vw", height: "100vh" }}>
      <SingleChatSurface threadId={"qa-agent-thread" as any} folderId={"qa-folder" as any} />
    </div>
  </SidebarProvider>,
);
window.desktopBridge.qa.ready();
