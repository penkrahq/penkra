// FILE: appTabAgentSurface.ts
// Purpose: Shared agent-surface rendering primitives ported from agent-browser v0.38.1.

import { randomBytes } from "node:crypto";

const BOUNDARY_NONCE = randomBytes(16).toString("hex");

// Agent input overlay, based on agent-browser cli/src/native/recording-cursor.js.
export const AGENT_CURSOR_SOURCE = `(() => {
  globalThis.__agentBrowserRecordingCursorCleanup?.();
  let host, pointer, shadow;
  const removers = [];
  let disposed = false;

  function mount() {
    if (disposed || host || !document.documentElement) return;
    host = document.createElement('agent-browser-recording-cursor');
    host.setAttribute('data-agent-browser-recording-cursor', '');
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('inert', '');
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;overflow:visible!important;contain:layout style!important;';
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = \`<style>
      :host, * { pointer-events: none !important; }
      .pointer { position: fixed; top: 0; left: 0; display: none; }
      svg { display: block; width: 28px; height: 28px; overflow: visible; transform-origin: 0 0; filter: drop-shadow(0 1px 1px #0008); }
      .pressed svg { transform: scale(.8); }
      .ripple { position: fixed; width: 64px; height: 64px; margin: -32px; border-radius: 50%; border: 2px solid #60a5fa; background: #60a5fa80; box-sizing: border-box; animation: ripple .4s linear forwards; }
      @keyframes ripple { from { transform: scale(0); opacity: .8; } to { transform: scale(1); opacity: 0; } }
    </style><div class="pointer"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M0 0L14 8.5L7.5 10L4 16Z" fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"/></svg></div>\`;
    pointer = shadow.querySelector('.pointer');
    document.documentElement.appendChild(host);
  }

  function update(input) {
    mount();
    if (!pointer) return;
    pointer.style.display = 'block';
    pointer.style.transform = \`translate3d(\${input.x}px,\${input.y}px,0)\`;
    if (input.type === 'mousePressed') pointer.classList.toggle('pressed', true);
    if (input.type === 'mouseReleased') pointer.classList.toggle('pressed', false);
    if (input.type === 'mousePressed') {
      const ripple = document.createElement('div');
      ripple.className = 'ripple';
      ripple.style.left = \`\${input.x}px\`;
      ripple.style.top = \`\${input.y}px\`;
      ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
      shadow.insertBefore(ripple, pointer);
    }
  }

  function listen(type, handler) {
    addEventListener(type, handler, { capture: true, passive: true });
    removers.push(() => removeEventListener(type, handler, true));
  }

  listen('DOMContentLoaded', mount);
  mount();
  globalThis.__penkraAgentCursorUpdate = update;
  globalThis.__agentBrowserRecordingCursorHide = () => {
    if (pointer) {
      pointer.style.display = 'none';
      pointer.classList.remove('pressed');
    }
  };
  globalThis.__agentBrowserRecordingCursorCleanup = () => {
    disposed = true;
    removers.forEach(remove => remove());
    host?.remove();
    delete globalThis.__penkraAgentCursorUpdate;
    delete globalThis.__agentBrowserRecordingCursorHide;
    delete globalThis.__agentBrowserRecordingCursorCleanup;
  };
})();`;

export function boundPageContent(content: string, origin: string): string {
  return `--- AGENT_BROWSER_PAGE_CONTENT nonce=${BOUNDARY_NONCE} origin=${origin || "unknown"} ---\n${content}\n--- END_AGENT_BROWSER_PAGE_CONTENT nonce=${BOUNDARY_NONCE} ---`;
}

export function compactSnapshot(snapshot: string, interactive: boolean): string {
  const lines = snapshot.split("\n").filter(Boolean);
  const keep = lines.map(() => false);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.includes("ref=") && !line.includes(": ") && !line.includes("value=")) continue;
    keep[index] = true;
    const indent = countIndent(line);
    for (let ancestor = index - 1; ancestor >= 0; ancestor -= 1) {
      const ancestorIndent = countIndent(lines[ancestor]!);
      if (ancestorIndent >= indent) continue;
      keep[ancestor] = true;
      if (ancestorIndent === 0) break;
    }
  }
  const result = lines.filter((_line, index) => keep[index]).join("\n");
  return result.trim() || (interactive ? "(no interactive elements)" : "");
}

function countIndent(line: string): number {
  return (line.length - line.trimStart().length) / 2;
}
