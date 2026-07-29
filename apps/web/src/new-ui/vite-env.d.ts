/// <reference types="vite/client" />

interface Window {
  penkraWindow?: {
    setMode(mode: "onboarding" | "workspace" | "workspace-wide"): void;
  };
}
