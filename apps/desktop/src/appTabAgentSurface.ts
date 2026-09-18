// FILE: appTabAgentSurface.ts
// Purpose: Shared agent-surface rendering primitives ported from agent-browser v0.38.1.

import { randomBytes } from "node:crypto";

const BOUNDARY_NONCE = randomBytes(16).toString("hex");

// Ported verbatim from agent-browser cli/src/native/recording-cursor.js.
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

  function update(event) {
    if (!event.isTrusted || event.pointerType !== 'mouse') return;
    mount();
    if (!pointer) return;
    pointer.style.display = 'block';
    pointer.style.transform = \`translate3d(\${event.clientX}px,\${event.clientY}px,0)\`;
    pointer.classList.toggle('pressed', event.buttons !== 0);
    if (event.type === 'pointerdown') {
      const ripple = document.createElement('div');
      ripple.className = 'ripple';
      ripple.style.left = \`\${event.clientX}px\`;
      ripple.style.top = \`\${event.clientY}px\`;
      ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
      shadow.insertBefore(ripple, pointer);
    }
  }

  function listen(type, handler) {
    addEventListener(type, handler, { capture: true, passive: true });
    removers.push(() => removeEventListener(type, handler, true));
  }

  listen('pointermove', update);
  listen('pointerdown', update);
  listen('pointerup', update);
  listen('pointerout', event => {
    if ((!event.relatedTarget || event.relatedTarget.localName === 'iframe') && pointer) pointer.style.display = 'none';
  });
  listen('DOMContentLoaded', mount);
  mount();
  globalThis.__agentBrowserRecordingCursorCleanup = () => {
    disposed = true;
    removers.forEach(remove => remove());
    host?.remove();
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

export interface SnapshotDiffResult {
  diff: string;
  additions: number;
  removals: number;
  unchanged: number;
  changed: boolean;
}

// Myers shortest-edit diff, matching agent-browser's `similar::TextDiff::from_lines` semantics.
export function diffSnapshots(before: string, after: string): SnapshotDiffResult {
  const left = before ? before.split("\n") : [];
  const right = after ? after.split("\n") : [];
  if (before === after)
    return { diff: "", additions: 0, removals: 0, unchanged: left.length, changed: false };
  const edits = myers(left, right);
  const additions = edits.filter((edit) => edit.kind === "+").length;
  const removals = edits.filter((edit) => edit.kind === "-").length;
  const unchanged = edits.filter((edit) => edit.kind === " ").length;
  return {
    diff: unified(edits),
    additions,
    removals,
    unchanged,
    changed: additions > 0 || removals > 0,
  };
}

type Edit = { kind: " " | "+" | "-"; line: string; left: number; right: number };

function myers(left: string[], right: string[]): Edit[] {
  const maximum = left.length + right.length;
  const trace: Map<number, number>[] = [];
  let frontier = new Map<number, number>([[1, 0]]);
  for (let distance = 0; distance <= maximum; distance += 1) {
    trace.push(new Map(frontier));
    const next = new Map<number, number>();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      let x =
        diagonal === -distance ||
        (diagonal !== distance && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1))
          ? frontier.get(diagonal + 1) ?? 0
          : (frontier.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < left.length && y < right.length && left[x] === right[y]) {
        x += 1;
        y += 1;
      }
      next.set(diagonal, x);
      if (x >= left.length && y >= right.length) return backtrack(trace, left, right, distance);
    }
    frontier = next;
  }
  return [];
}

function backtrack(trace: Map<number, number>[], left: string[], right: string[], distance: number): Edit[] {
  let x = left.length;
  let y = right.length;
  const edits: Edit[] = [];
  for (let d = distance; d >= 0; d -= 1) {
    const frontier = trace[d]!;
    const diagonal = x - y;
    const previousDiagonal =
      diagonal === -d ||
      (diagonal !== d && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1))
        ? diagonal + 1
        : diagonal - 1;
    const previousX = frontier.get(previousDiagonal) ?? 0;
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      edits.push({ kind: " ", line: left[x - 1]!, left: x, right: y });
      x -= 1;
      y -= 1;
    }
    if (d === 0) break;
    if (x === previousX) {
      edits.push({ kind: "+", line: right[y - 1]!, left: x, right: y });
      y -= 1;
    } else {
      edits.push({ kind: "-", line: left[x - 1]!, left: x, right: y });
      x -= 1;
    }
  }
  return edits.reverse();
}

function unified(edits: Edit[]): string {
  const changed = edits.flatMap((edit, index) => (edit.kind === " " ? [] : [index]));
  if (changed.length === 0) return "";
  const included = new Set<number>();
  for (const index of changed)
    for (let cursor = Math.max(0, index - 3); cursor <= Math.min(edits.length - 1, index + 3); cursor += 1)
      included.add(cursor);
  const lines = ["--- before", "+++ after"];
  let cursor = 0;
  while (cursor < edits.length) {
    if (!included.has(cursor)) {
      cursor += 1;
      continue;
    }
    const start = cursor;
    while (cursor + 1 < edits.length && included.has(cursor + 1)) cursor += 1;
    const hunk = edits.slice(start, cursor + 1);
    const leftStart = hunk.find((edit) => edit.kind !== "+")?.left ?? hunk[0]!.left + 1;
    const rightStart = hunk.find((edit) => edit.kind !== "-")?.right ?? hunk[0]!.right + 1;
    const leftCount = hunk.filter((edit) => edit.kind !== "+").length;
    const rightCount = hunk.filter((edit) => edit.kind !== "-").length;
    lines.push(`@@ -${leftStart},${leftCount} +${rightStart},${rightCount} @@`);
    lines.push(...hunk.map((edit) => `${edit.kind}${edit.line}`));
    cursor += 1;
  }
  return `${lines.join("\n")}\n`;
}
