import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { it, expect } from "vitest";
import { AppTabObserver } from "./appTabObserver";

it("characterizes protocol-session retention after out-of-process frame churn", async () => {
  const contents = new EventEmitter() as any,
    debuggerEvents = new EventEmitter();
  let index = 0;
  contents.id = 8675309;
  contents.isDestroyed = () => false;
  contents.getURL = () => "about:blank";
  contents.getTitle = () => "Audit";
  contents.executeJavaScript = async () => false;
  contents.debugger = {
    isAttached: () => true,
    on: debuggerEvents.on.bind(debuggerEvents),
    sendCommand: async (method: string) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "shell", url: "about:blank" } } };
      if (method === "Target.getTargets")
        return {
          targetInfos: [
            { targetId: "target-" + index, url: "https://audit.invalid/frame-" + index },
          ],
        };
      if (method === "Target.attachToTarget") return { sessionId: "session-" + index };
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      return {};
    },
  };
  const observer = new AppTabObserver({
    resolve: () => ({
      descriptor: {
        id: "audit-tab",
        slug: "audit",
        documentUrl: "https://audit.invalid/frame-" + index,
      } as never,
      webContents: contents,
      frame: {
        url: "https://audit.invalid/frame-" + index,
        executeJavaScript: async () => "Audit",
      } as never,
    }),
  });
  for (index = 0; index < 100; index++) {
    await observer.snapshot("audit-tab");
    debuggerEvents.emit("message", {}, "Target.detachedFromTarget", {
      sessionId: "session-" + index,
      targetId: "target-" + index,
    });
    observer.invalidate("audit-tab");
  }
  const after = observer.getPerformanceSnapshot();
  expect(after.snapshotStateCount).toBe(0);
  expect(after.protocolSessionCount).toBe(100);
  const report = new URL(
    "../../../.penkra/scratch/performance-20260908/observer-churn.json",
    import.meta.url,
  );
  mkdirSync(new URL("./", report), { recursive: true });
  writeFileSync(
    report,
    JSON.stringify(
      {
        utc: new Date().toISOString(),
        cycles: 100,
        after,
        limitation:
          "Synthetic OOP-frame target churn using actual observer; no CPU or heap growth magnitude established",
      },
      null,
      2,
    ),
  );
});
