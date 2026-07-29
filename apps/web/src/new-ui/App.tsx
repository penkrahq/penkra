import { useCallback, useEffect, useRef, useState } from "react";
import { installPencilRuntime, type Phase } from "./pencilRuntime";
import { installResponsiveLayout } from "./responsiveLayout";
import { useMacWindowedTrafficLightGutter } from "./useMacTrafficLightGutter";

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
  const frameRef = useRef<HTMLIFrameElement>(null);
  const onboarding = onboardingPhases.has(phase);
  const sourceWidth = phase === "workspace" ? 1512 : 1440;
  const macTrafficLightGutter = useMacWindowedTrafficLightGutter();

  const go = useCallback((next: Phase) => {
    sessionStorage.setItem("penkra-mock-phase", next);
    setPhase(next);
  }, []);

  useEffect(() => {
    const mode = onboarding ? "onboarding" : sourceWidth === 1512 ? "workspace-wide" : "workspace";
    window.penkraWindow?.setMode(mode);
  }, [onboarding, sourceWidth]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const onLoad = () => {
      const document = frame.contentDocument;
      if (!document) return;
      installResponsiveLayout(document, phase, { macTrafficLightGutter });
      void installPencilRuntime(document, phase, { go });
    };

    frame.addEventListener("load", onLoad);
    return () => frame.removeEventListener("load", onLoad);
  }, [go, macTrafficLightGutter, phase]);

  useEffect(() => {
    const document = frameRef.current?.contentDocument;
    if (document) installResponsiveLayout(document, phase, { macTrafficLightGutter });
  }, [macTrafficLightGutter, phase]);

  return (
    <main
      className="pencil-stage"
      data-window-chrome={macTrafficLightGutter > 0 ? "macos-windowed" : "flush"}
    >
      <div className="pencil-viewport">
        <iframe
          ref={frameRef}
          key={phase}
          className="pencil-frame"
          sandbox="allow-same-origin"
          src={phaseFile[phase]}
          title="Penkra"
        />
      </div>
    </main>
  );
}
