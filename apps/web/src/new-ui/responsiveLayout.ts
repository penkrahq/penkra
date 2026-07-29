import type { Phase } from "./pencilRuntime";

const ONBOARDING_PHASES = new Set<Phase>(["welcome", "agents", "connections", "api-key", "apps"]);

const BASE_CSS = `
  html,
  body {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: hidden;
    background: #0f1115;
  }

  body > [data-pencil-name] {
    width: 100% !important;
    height: 100% !important;
  }
`;

const WORKSPACE_CSS = `
  body > [data-pencil-name] > [data-pencil-name="Sidebar"],
  body > [data-pencil-name] > [data-pencil-name="Thread"],
  body > [data-pencil-name] > [data-pencil-name="Right Panel"] {
    height: 100% !important;
  }

  body > [data-pencil-name] > [data-pencil-name="Thread"] {
    min-width: 0 !important;
  }

  body > [data-pencil-name] > [data-pencil-name="Sidebar"] > [data-pencil-name="Header"] {
    height: 46px !important;
    min-height: 46px !important;
  }

  body > [data-pencil-name] > [data-pencil-name="Dim Backdrop"] {
    width: 100% !important;
    height: 100% !important;
  }

  body > [data-pencil-name] > [data-pencil-name="Thread"][style*="position: absolute"] {
    left: 240px !important;
    width: calc(100% - 660px) !important;
  }

  body > [data-pencil-name] > [data-pencil-name="Right Panel"][style*="position: absolute"] {
    left: auto !important;
    right: 0 !important;
  }

  [data-pencil-name="Settings Modal"] {
    width: min(880px, calc(100% - 32px)) !important;
    height: min(640px, calc(100% - 32px)) !important;
  }

  [data-pencil-name="Settings Modal"] > [data-pencil-name="Nav"] {
    height: 100% !important;
  }

  @media (max-width: 1100px) {
    [data-pencil-name="Apps panel"] {
      position: relative !important;
    }

    [data-pencil-name="Apps panel"] > [data-pencil-name="Right Panel"] {
      position: absolute !important;
      top: 0 !important;
      right: 0 !important;
      box-shadow: -20px 0 40px #00000066;
    }

    body > [data-pencil-name] > [data-pencil-name="Thread"][style*="position: absolute"] {
      width: calc(100% - 240px) !important;
    }

    body > [data-pencil-name] > [data-pencil-name="Right Panel"][style*="position: absolute"] {
      display: none !important;
    }
  }

  @media (max-width: 720px) {
    body > [data-pencil-name] > [data-pencil-name="Sidebar"] {
      display: none !important;
    }

    body > [data-pencil-name] > [data-pencil-name="Thread"][style*="position: absolute"] {
      left: 0 !important;
      width: 100% !important;
    }

    [data-pencil-name="Settings Modal"] > [data-pencil-name="Nav"] {
      width: 176px !important;
    }
  }
`;

const ONBOARDING_CSS = `
  [data-pencil-name="Onboarding Panel"] {
    position: absolute !important;
    left: 50% !important;
    top: 50% !important;
    transform: translate(-50%, -50%);
  }

  @media (max-width: 1100px), (max-height: 700px) {
    [data-pencil-name="Onboarding Panel"] {
      width: min(600px, calc(100% - 32px)) !important;
      height: min(640px, calc(100% - 32px)) !important;
    }

    [data-pencil-name="Onboarding Panel"] > [data-pencil-name="Brand Panel"] {
      display: none !important;
    }

    [data-pencil-name="Onboarding Panel"] > [data-pencil-name="Main"],
    [data-pencil-name="Onboarding Panel"] > [data-pencil-name="Column"] {
      width: 100% !important;
      height: 100% !important;
      overflow: auto !important;
    }
  }
`;

export function installResponsiveLayout(
  document: Document,
  phase: Phase,
  options: { macTrafficLightGutter: number },
) {
  const existing = document.querySelector<HTMLStyleElement>("style[data-penkra-responsive]");
  existing?.remove();

  const style = document.createElement("style");
  style.dataset.penkraResponsive = "true";
  const trafficLightCss =
    options.macTrafficLightGutter > 0
      ? `
  body > [data-pencil-name] > [data-pencil-name="Sidebar"] > [data-pencil-name="Header"] {
    padding-left: ${options.macTrafficLightGutter}px !important;
  }
`
      : "";
  style.textContent = `${BASE_CSS}\n${
    ONBOARDING_PHASES.has(phase) ? ONBOARDING_CSS : WORKSPACE_CSS
  }\n${trafficLightCss}`;
  document.head.append(style);
}
