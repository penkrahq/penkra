import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { installPencilRuntime, type Phase } from "./pencilRuntime";

const phaseFile: Record<Phase, string> = {
  welcome: "./pencil/welcome.html",
  agents: "./pencil/agents.html",
  connections: "./pencil/connections.html",
  "api-key": "./pencil/api-key.html",
  apps: "./pencil/apps.html",
  workspace: "./pencil/workspace.html",
  "apps-panel": "./pencil/apps-panel.html",
  permission: "./pencil/permission.html",
  settings: "./pencil/settings.html",
  "settings-permissions": "./pencil/settings-permissions.html",
  "settings-agents": "./pencil/settings-agents.html",
  "settings-apps": "./pencil/settings-apps.html",
  "settings-connectors": "./pencil/settings-connectors.html",
  "settings-appearance": "./pencil/settings-appearance.html",
  "settings-account": "./pencil/settings-account.html",
};

const onboardingPhases = new Set<Phase>(["welcome", "agents", "connections", "api-key", "apps"]);

function initialPhase(): Phase {
  const requested = new URLSearchParams(window.location.search).get("phase") as Phase | null;
  if (requested && requested in phaseFile) return requested;
  const saved = sessionStorage.getItem("penkra-mock-phase") as Phase | null;
  return saved && saved in phaseFile ? saved : "welcome";
}

export function App() {
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [scale, setScale] = useState(1);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const onboarding = onboardingPhases.has(phase);
  const sourceWidth = phase === "workspace" ? 1512 : 1440;
  const viewport = useMemo(
    () => (onboarding ? { width: 1440, height: 900 } : { width: sourceWidth, height: 900 }),
    [onboarding, sourceWidth],
  );

  const go = useCallback((next: Phase) => {
    sessionStorage.setItem("penkra-mock-phase", next);
    setPhase(next);
  }, []);

  useEffect(() => {
    const mode = onboarding ? "onboarding" : sourceWidth === 1512 ? "workspace-wide" : "workspace";
    window.penkraWindow?.setMode(mode);
  }, [onboarding, sourceWidth]);

  useEffect(() => {
    const fit = () => {
      setScale(Math.min(window.innerWidth / viewport.width, window.innerHeight / viewport.height));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [viewport]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const onLoad = () => {
      const document = frame.contentDocument;
      if (!document) return;
      void installPencilRuntime(document, phase, { go });
    };

    frame.addEventListener("load", onLoad);
    return () => frame.removeEventListener("load", onLoad);
  }, [go, phase]);

  const frameOffset = onboarding
    ? { left: 0, top: 0 }
    : { left: (viewport.width - sourceWidth) / 2, top: 0 };

  return (
    <main className="pencil-stage">
      <div
        className="pencil-viewport"
        style={{
          width: viewport.width,
          height: viewport.height,
          transform: `translate(-50%, -50%) scale(${scale})`,
        }}
      >
        <iframe
          ref={frameRef}
          key={phase}
          className="pencil-frame"
          src={phaseFile[phase]}
          title="Penkra"
          style={{
            left: frameOffset.left,
            top: frameOffset.top,
            width: sourceWidth,
            height: 900,
          }}
        />
      </div>
    </main>
  );
}
