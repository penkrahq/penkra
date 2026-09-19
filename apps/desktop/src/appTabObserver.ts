// FILE: appTabObserver.ts
// Purpose: Provides the trusted, host-only semantic observer for isolated App-tab WebContents.
// Layer: Desktop agent capability bridge (never exposed through the App SDK)

import type { Rectangle, WebContents } from "electron";
import type { DesktopAppTabDescriptor } from "@penkra/contracts";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { delimiter, dirname, extname, join } from "node:path";
import { spawn } from "node:child_process";
import { appTabKeyDefinition } from "./appTabKeyboard";
import {
  AGENT_CURSOR_SOURCE,
  boundPageContent,
  compactSnapshot,
  diffSnapshots,
} from "./appTabAgentSurface";

const MAX_VALUE_LENGTH = 2_000;
const MAX_INLINE_SCREENSHOT_BYTES = 12 * 1024 * 1024;
const MAX_WAIT_MS = 25_000;

const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

interface CdpValue {
  value?: unknown;
}

interface CdpAxProperty {
  name?: string;
  value?: CdpValue;
}

interface CdpAxNode {
  nodeId?: string;
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: CdpValue;
  name?: CdpValue;
  value?: CdpValue;
  description?: CdpValue;
  properties?: CdpAxProperty[];
}

interface SnapshotReference {
  backendNodeId: number;
  loaderId: string;
  target: AppTabObservationTarget;
}

interface TabSnapshotState {
  document: AppTabDocument;
  loaderId: string;
  nextReference: number;
  references: Map<string, SnapshotReference>;
  referenceByBackendNodeId: Map<number, string>;
  observedTargetKey: string;
  lastSnapshot: string | null;
  lastSnapshotReferences: Set<string>;
  dispose: () => void;
}

interface TabCapture {
  bytes: Buffer;
  cssWidth: number;
  cssHeight: number;
}

interface PendingJavaScriptDialog {
  type: string;
  message: string;
  url: string;
  defaultPrompt: string;
  target: AppTabObservationTarget;
}

interface CursorInstallation {
  destroyedListener: () => void;
  instanceId: string;
  ownerThreadId: string | null;
  ownerThreadWasActive: boolean;
  scriptId: string | null;
  target: AppTabObservationTarget;
  worldName: string;
}

interface AppTabSnapshotOptions {
  document?: AppTabDocument;
  target?: string;
  depth?: number;
  boxes?: boolean;
  interactive?: boolean;
  compact?: boolean;
  outputPath?: string;
}

export type AppTabDocument = "d1" | "d2";

export type AppTabActStep =
  | { action: "click" | "hover"; ref: string }
  | { action: "highlight"; ref: string }
  | { action: "type"; ref: string; text: string }
  | { action: "select"; ref: string; value: string }
  | { action: "upload"; ref: string; paths: ReadonlyArray<string> }
  | { action: "press"; document: AppTabDocument; key: string }
  | { action: "scroll"; document: AppTabDocument; deltaX?: number; deltaY?: number }
  | { action: "wait"; document: AppTabDocument; text: string; timeoutMs?: number }
  | { action: "dialog"; accept: boolean; text?: string };

export interface AppTabObservationTarget {
  descriptor: DesktopAppTabDescriptor;
  document: AppTabDocument;
  webContents: WebContents;
  cdpSessionId?: string;
  /** Null means the shell is not currently painting this tab. */
  captureBounds?: () => Promise<Rectangle | null> | Rectangle | null;
}

export interface AppTabObserverResolver {
  resolve(
    tabId: string,
    document: AppTabDocument,
    surfaceId?: number,
  ):
    | Promise<Omit<AppTabObservationTarget, "document"> & { document?: AppTabDocument }>
    | (Omit<AppTabObservationTarget, "document"> & { document?: AppTabDocument });
  validateUploadPaths?(
    descriptor: DesktopAppTabDescriptor,
    paths: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<string>>;
}

export interface AppTabObserverPerformanceSnapshot {
  snapshotCalls: number;
  snapshotTotalMs: number;
  screenshotCalls: number;
  screenshotTotalMs: number;
  capturePageCalls: number;
  capturePageTotalMs: number;
  capturePageBytes: number;
  cdpCalls: number;
  cdpTotalMs: number;
  snapshotStateCount: number;
  dialogListenerCount: number;
  protocolSessionCount: number;
}

export class AppTabObserver {
  readonly #resolver: AppTabObserverResolver;
  readonly #surface = new AsyncLocalStorage<number | undefined>();
  readonly #states = new Map<string, TabSnapshotState>();
  readonly #snapshotTails = new Map<string, Promise<void>>();
  readonly #protocolSessions = new Map<
    string,
    { contentsId: number; targetId: string; sessionId: string }
  >();
  readonly #dialogTargets = new Map<string, { tabId: string; target: AppTabObservationTarget }>();
  readonly #dialogTabsByContents = new Map<number, Set<string>>();
  readonly #dialogListeners = new Set<number>();
  readonly #pendingDialogs = new Map<string, PendingJavaScriptDialog>();
  readonly #cursorInstallations = new Map<string, CursorInstallation>();
  readonly #cursorLoaders = new Map<string, string>();
  readonly #cursorPositions = new Map<string, { x: number; y: number }>();
  readonly #activeTurnThreadIds = new Set<string>();
  readonly #cursorOwnerThread = new AsyncLocalStorage<string | undefined>();
  #activeCursorKey: string | null = null;
  readonly #perfCounters = {
    snapshotCalls: 0,
    snapshotTotalMs: 0,
    screenshotCalls: 0,
    screenshotTotalMs: 0,
    capturePageCalls: 0,
    capturePageTotalMs: 0,
    capturePageBytes: 0,
    cdpCalls: 0,
    cdpTotalMs: 0,
  };

  constructor(resolver: AppTabObserverResolver) {
    this.#resolver = resolver;
  }

  runOnSurface<T>(surfaceId: number | null, operation: () => Promise<T>): Promise<T> {
    return this.#surface.run(surfaceId ?? undefined, operation);
  }

  setActiveTurnThreadIds(threadIds: ReadonlyArray<string>): void {
    this.#activeTurnThreadIds.clear();
    for (const threadId of threadIds) this.#activeTurnThreadIds.add(threadId);
    for (const [key, installation] of this.#cursorInstallations) {
      const ownerThreadId = installation.ownerThreadId;
      if (!ownerThreadId) continue;
      if (this.#activeTurnThreadIds.has(ownerThreadId)) {
        installation.ownerThreadWasActive = true;
        continue;
      }
      if (!installation.ownerThreadWasActive) continue;
      void this.#removeCursor(key, installation, "turn-complete");
    }
  }

  getPerformanceSnapshot(): AppTabObserverPerformanceSnapshot {
    return {
      ...this.#perfCounters,
      snapshotStateCount: this.#states.size,
      dialogListenerCount: this.#dialogListeners.size,
      protocolSessionCount: this.#protocolSessions.size,
    };
  }

  invalidate(tabId: string): void {
    for (const [key, state] of this.#states) {
      if (!key.startsWith(`${tabId}:`)) continue;
      state.dispose();
      this.#states.delete(key);
    }
    this.#pendingDialogs.delete(tabId);
    for (const [key, owner] of this.#dialogTargets) {
      if (owner.tabId === tabId) this.#dialogTargets.delete(key);
    }
    for (const [contentsId, tabIds] of this.#dialogTabsByContents) {
      tabIds.delete(tabId);
      if (tabIds.size === 0) this.#dialogTabsByContents.delete(contentsId);
    }
    void this.#removeCursorsForTab(tabId, "tab-invalidated");
  }

  async snapshot(tabId: string, options: AppTabSnapshotOptions = {}): Promise<unknown> {
    const prior = this.#snapshotTails.get(tabId) ?? Promise.resolve();
    const operation = prior.catch(() => undefined).then(() => this.#snapshotNow(tabId, options));
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#snapshotTails.set(tabId, tail);
    try {
      return await operation;
    } finally {
      if (this.#snapshotTails.get(tabId) === tail) this.#snapshotTails.delete(tabId);
    }
  }

  async #snapshotNow(tabId: string, options: AppTabSnapshotOptions): Promise<unknown> {
    const startedAt = performance.now();
    this.#perfCounters.snapshotCalls += 1;
    try {
      const document = options.document ?? "d1";
      const target = await this.#target(tabId, document);
      const loaderId = await this.#loaderId(target);
      const state = this.#state(tabId, target, loaderId);
      const scopedReference =
        options.target === undefined ? undefined : this.#reference(state, options.target);
      const depth = options.depth === undefined ? undefined : normalizeDepth(options.depth);
      const appTree =
        scopedReference && !sameProtocolTarget(scopedReference.target, target)
          ? { lines: [], references: new Set<string>() }
          : await this.#snapshotLines(
              target,
              state,
              scopedReference?.backendNodeId,
              depth,
              options.boxes === true,
              options.interactive === true,
            );
      let rawSnapshot = appTree.lines.join("\n");
      if (options.compact === true)
        rawSnapshot = compactSnapshot(rawSnapshot, options.interactive === true);
      const removedRefs = [...state.lastSnapshotReferences]
        .filter((reference) => !appTree.references.has(reference))
        .sort(referenceOrder);
      state.lastSnapshotReferences = appTree.references;
      const refs = Object.fromEntries(
        [...appTree.references].sort(referenceOrder).map((reference) => [reference, {
          role: referenceRole(rawSnapshot, reference),
          name: referenceName(rawSnapshot, reference),
        }]),
      );
      const url = target.webContents.getURL();
      const snapshot = boundPageContent(rawSnapshot, url);

      const result = {
        tabId,
        document,
        loaderId,
        snapshotId: randomUUID(),
        app: target.descriptor.slug,
        url,
        title: target.webContents.getTitle(),
        snapshot,
        refs,
        removedRefs,
      };
      state.lastSnapshot = rawSnapshot;
      if (!options.outputPath) return result;
      await writeFileAtomically(options.outputPath, Buffer.from(`${snapshot}\n`, "utf8"));
      const { snapshot: _snapshot, ...metadata } = result;
      return { ...metadata, filename: options.outputPath };
    } finally {
      this.#perfCounters.snapshotTotalMs += performance.now() - startedAt;
    }
  }

  async #snapshotLines(
    target: AppTabObservationTarget,
    state: TabSnapshotState,
    backendNodeId: number | undefined,
    maxDepth: number | undefined,
    includeBoxes: boolean,
    interactive: boolean,
  ): Promise<{ lines: string[]; references: Set<string> }> {
    const protocol = { target };
    const response = asRecord(
      await this.#cdp(
        protocol.target.webContents,
        backendNodeId === undefined
          ? "Accessibility.getFullAXTree"
          : "Accessibility.getPartialAXTree",
        backendNodeId === undefined
          ? undefined
          : { backendNodeId, fetchRelatives: false },
        protocol.target.cdpSessionId,
      ),
    );
    const rawNodes = Array.isArray(response.nodes) ? (response.nodes as CdpAxNode[]) : [];
    const byId = new Map(rawNodes.flatMap((node) => (node.nodeId ? [[node.nodeId, node]] : [])));
    const childIds = new Set(rawNodes.flatMap((node) => node.childIds ?? []));
    const roots = rawNodes.filter(
      (node) => !node.parentId || !byId.has(node.parentId) || !childIds.has(node.nodeId ?? ""),
    );
    const effectiveRoots = roots.length > 0 ? roots : rawNodes.slice(0, 1);
    const lines: string[] = [];
    const references = new Set<string>();
    const rendered = new Map<CdpAxNode, string | null>();
    await Promise.all(
      rawNodes.map(async (raw) => {
        if (raw.ignored === true) return;
        rendered.set(raw, await this.#snapshotLine(protocol.target, raw, state, includeBoxes, references));
      }),
    );
    const visited = new Set<CdpAxNode>();
    const visit = (raw: CdpAxNode, depth: number): void => {
      if (visited.has(raw)) return;
      visited.add(raw);
      if (maxDepth !== undefined && depth > maxDepth) return;
      const children = (raw.childIds ?? []).flatMap((id) => {
        const child = byId.get(id);
        return child ? [child] : [];
      });
      if (raw.ignored === true) {
        for (const child of children) visit(child, depth);
        return;
      }
      const line = rendered.get(raw) ?? null;
      const visibleLine = interactive && !line?.includes("ref=") ? null : line;
      if (visibleLine) lines.push(`${"  ".repeat(depth)}${visibleLine}`);
      const childDepth = visibleLine ? depth + 1 : depth;
      for (const child of children) visit(child, childDepth);
    };
    for (const root of effectiveRoots) visit(root, 0);
    // Older Chromium test doubles and partial trees may omit relationships. Preserve their
    // protocol order rather than dropping valid nodes.
    for (const raw of rawNodes) if (!visited.has(raw)) visit(raw, 0);
    return { lines, references };
  }

  async #snapshotLine(
    target: AppTabObservationTarget,
    raw: CdpAxNode,
    state: TabSnapshotState,
    includeBox: boolean,
    seenReferences: Set<string>,
  ): Promise<string | null> {
    const role = normalizeAxRole(cdpText(raw.role));
    const name = cdpText(raw.name);
    const value = cdpText(raw.value);
    const description = cdpText(raw.description);
    const properties = axProperties(raw.properties);
    const attributes: string[] = [];
    let reference: string | undefined;
    if (
      (INTERACTIVE_ROLES.has(role) || (role !== "document" && properties.focusable === true)) &&
      typeof raw.backendDOMNodeId === "number"
    ) {
      reference = state.referenceByBackendNodeId.get(raw.backendDOMNodeId);
      if (!reference) {
        reference = `${state.document}:e${state.nextReference++}`;
        state.referenceByBackendNodeId.set(raw.backendDOMNodeId, reference);
        state.references.set(reference, {
          backendNodeId: raw.backendDOMNodeId,
          loaderId: state.loaderId,
          target,
        });
      }
    }
    if (reference) seenReferences.add(reference);
    for (const key of [
      "checked",
      "disabled",
      "expanded",
      "level",
      "pressed",
      "selected",
    ] as const) {
      const value = properties[key];
      if (value === true) attributes.push(key);
      else if (value !== undefined && value !== false) attributes.push(`${key}=${String(value)}`);
    }
    if (reference) attributes.push(`ref=${reference}`);
    if (includeBox && typeof raw.backendDOMNodeId === "number") {
      const box = await this.#nodeBox(target, raw.backendDOMNodeId);
      if (box) attributes.push(`box=${box.x},${box.y},${box.width},${box.height}`);
    }
    const protectedValue =
      value && isProtectedValue(role, properties, value) ? "[redacted]" : value;
    if (!name && !protectedValue && !description && role === "generic" && attributes.length === 0)
      return null;
    if (role === "text" && (name || protectedValue)) {
      return `- text: ${JSON.stringify(bounded(name || protectedValue))}`;
    }
    const details = [
      name ? JSON.stringify(bounded(name)) : "",
      protectedValue ? `value=${JSON.stringify(bounded(protectedValue))}` : "",
      description ? `description=${JSON.stringify(bounded(description))}` : "",
      ...attributes.map((attribute) => `[${attribute}]`),
    ].filter(Boolean);
    return `- ${role}${details.length > 0 ? ` ${details.join(" ")}` : ""}`;
  }

  async find(tabId: string, query: string, document: AppTabDocument = "d1"): Promise<unknown> {
    const observation = (await this.snapshot(tabId, { document })) as {
      tabId: string;
      app: string;
      url: string;
      title: string;
      snapshot: string;
    };
    const matcher = compileFindPattern(query);
    const lines = this.#states.get(`${tabId}:${document}`)?.lastSnapshot?.split("\n") ?? [];
    const matches: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      matcher.lastIndex = 0;
      if (!matcher.test(lines[index]!)) continue;
      const start = Math.max(0, index - 2);
      const end = Math.min(lines.length, index + 3);
      matches.push(lines.slice(start, end).join("\n"));
    }
    const { snapshot: _snapshot, ...metadata } = observation;
    return { ...metadata, query, matches };
  }

  async diff(tabId: string, document: AppTabDocument = "d1"): Promise<unknown> {
    const before = this.#states.get(`${tabId}:${document}`)?.lastSnapshot ?? "";
    const observation = (await this.snapshot(tabId, { document })) as Record<string, unknown> & {
      snapshot: string;
    };
    const after = this.#states.get(`${tabId}:${document}`)?.lastSnapshot ?? "";
    return {
      ...observation,
      ...diffSnapshots(before, after),
    };
  }

  async evaluate(tabId: string, document: AppTabDocument, expression: string): Promise<unknown> {
    const target = await this.#target(tabId, document);
    return {
      tabId,
      document,
      value: await this.#execute(target, expression, true),
    };
  }

  async act(
    tabId: string,
    steps: ReadonlyArray<AppTabActStep>,
    human = false,
    ownerThreadId?: string,
  ): Promise<unknown> {
    return this.#cursorOwnerThread.run(ownerThreadId, async () => {
      const results: unknown[] = [];
      for (const step of steps) {
        switch (step.action) {
          case "click":
            results.push(await this.click(tabId, step.ref, false, human));
            break;
          case "hover":
            results.push(await this.hover(tabId, step.ref, false, human));
            break;
          case "highlight":
            results.push(await this.highlight(tabId, step.ref));
            break;
          case "type":
            results.push(await this.type(tabId, step.ref, step.text, false, human));
            break;
          case "select":
            results.push(await this.select(tabId, step.ref, step.value));
            break;
          case "upload":
            results.push(await this.upload(tabId, step.ref, step.paths));
            break;
          case "press":
            results.push(await this.press(tabId, step.key, false, step.document));
            break;
          case "scroll":
            results.push(
              await this.scroll(
                tabId,
                step.deltaX ?? 0,
                step.deltaY ?? 0,
                false,
                step.document,
              ),
            );
            break;
          case "wait":
            results.push(
              await this.wait(tabId, step.text, step.timeoutMs ?? 10_000, step.document),
            );
            break;
          case "dialog":
            results.push(await this.handleDialog(tabId, step.accept, step.text));
            break;
        }
      }
      return { tabId, inputMode: human ? "human" : "smooth", steps: results };
    });
  }

  async screenshot(
    tabId: string,
    document: AppTabDocument = "d1",
    outputPath?: string,
  ): Promise<unknown> {
    const startedAt = performance.now();
    this.#perfCounters.screenshotCalls += 1;
    try {
      const target = await this.#target(tabId, document);
      const capture = await this.#captureTarget(target);
      const bytes = capture.bytes;
      if (bytes.byteLength === 0)
        throw observerError("SCREENSHOT_NEVER_PAINTED", `${document} never painted.`);
      if (outputPath) {
        await writeFileAtomically(outputPath, bytes);
        return { tabId, document, filename: outputPath, mimeType: "image/png" };
      }
      if (bytes.byteLength > MAX_INLINE_SCREENSHOT_BYTES) {
        throw new Error("The PNG does not fit in the inline tool transport. Supply filename to save it instead.");
      }
      return {
        tabId,
        document,
        kind: "image",
        mimeType: "image/png",
        data: bytes.toString("base64"),
      };
    } finally {
      this.#perfCounters.screenshotTotalMs += performance.now() - startedAt;
    }
  }

  async record(
    tabId: string,
    document: AppTabDocument,
    durationMs: number,
    outputPath: string,
  ): Promise<unknown> {
    const target = await this.#target(tabId, document);
    const duration = boundedDuration(durationMs);
    const extension = extname(outputPath).toLowerCase();
    if (extension !== ".webm" && extension !== ".mp4")
      throw new Error("Recording filename must end in .webm or .mp4.");
    await mkdir(dirname(outputPath), { recursive: true });
    await this.#ensureCursor(target);
    const ffmpeg = spawn(resolveFfmpegExecutable(), recordingFfmpegArguments(outputPath, extension), {
      stdio: ["pipe", "ignore", "pipe"],
    });
    const completion = new Promise<number | null>((resolve, reject) => {
      ffmpeg.once("error", reject);
      ffmpeg.once("close", resolve);
    });
    let stderr = "";
    ffmpeg.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    let latest: Buffer | null = null;
    let frames = 0;
    const listener = (_event: Electron.Event, method: string, params: unknown, sessionId?: string) => {
      if (method !== "Page.screencastFrame" || !isRecord(params)) return;
      if (target.cdpSessionId !== undefined && sessionId !== target.cdpSessionId) return;
      if (typeof params.data === "string") latest = Buffer.from(params.data, "base64");
      void this.#cdp(
        target.webContents,
        "Page.screencastFrameAck",
        { sessionId: params.sessionId },
        target.cdpSessionId,
      ).catch(() => undefined);
    };
    target.webContents.debugger.on("message", listener);
    const startedAt = Date.now();
    try {
      await this.#cdp(
        target.webContents,
        "Page.startScreencast",
        { format: "jpeg", quality: 90, everyNthFrame: 1 },
        target.cdpSessionId,
      );
      while (Date.now() - startedAt <= duration) {
        if (latest && ffmpeg.stdin?.writable) {
          ffmpeg.stdin.write(latest);
          frames += 1;
        }
        await delay(33);
      }
    } finally {
      target.webContents.debugger.removeListener("message", listener);
      await this.#cdp(target.webContents, "Page.stopScreencast", undefined, target.cdpSessionId).catch(
        () => undefined,
      );
      ffmpeg.stdin?.end();
      await this.#removeCursorsForTab(tabId, "record-complete");
    }
    const exitCode = await completion;
    if (frames === 0) throw observerError("SCREENSHOT_NEVER_PAINTED", `${document} never painted.`);
    if (exitCode !== 0) throw new Error(`ffmpeg failed: ${stderr.trim().split("\n").slice(-3).join(" ")}`);
    return { tabId, document, filename: outputPath, durationMs: Date.now() - startedAt, frames };
  }

  async trace(
    tabId: string,
    document: AppTabDocument,
    durationMs: number,
    outputPath: string,
  ): Promise<unknown> {
    const target = await this.#target(tabId, document);
    const duration = boundedDuration(durationMs);
    const events: unknown[] = [];
    const complete = new Promise<void>((resolve) => {
      const listener = (_event: Electron.Event, method: string, params: unknown) => {
        if (method === "Tracing.dataCollected" && isRecord(params) && Array.isArray(params.value)) {
          events.push(...params.value);
        }
        if (method === "Tracing.tracingComplete") {
          target.webContents.debugger.removeListener("message", listener);
          resolve();
        }
      };
      target.webContents.debugger.on("message", listener);
    });
    await this.#cdp(target.webContents, "Tracing.start", {
      categories: "devtools.timeline,v8,blink.user_timing",
      transferMode: "ReportEvents",
    });
    await delay(duration);
    await this.#cdp(target.webContents, "Tracing.end");
    await complete;
    await writeFileAtomically(outputPath, Buffer.from(JSON.stringify({ traceEvents: events })));
    return { tabId, document, filename: outputPath, events: events.length };
  }

  async har(
    tabId: string,
    document: AppTabDocument,
    durationMs: number,
    outputPath: string,
  ): Promise<unknown> {
    const target = await this.#target(tabId, document);
    const duration = boundedDuration(durationMs);
    const requests = new Map<
      string,
      { startedDateTime: string; request?: Record<string, unknown>; response?: Record<string, unknown> }
    >();
    const listener = (
      _event: Electron.Event,
      method: string,
      params: unknown,
      sessionId?: string,
    ) => {
      if (
        (target.cdpSessionId !== undefined && sessionId !== target.cdpSessionId) ||
        !isRecord(params)
      )
        return;
      const requestId = typeof params.requestId === "string" ? params.requestId : null;
      if (!requestId) return;
      if (method === "Network.requestWillBeSent") {
        requests.set(requestId, {
          startedDateTime: new Date().toISOString(),
          request: asRecord(params.request),
        });
      } else if (method === "Network.responseReceived") {
        const entry = requests.get(requestId);
        if (entry) entry.response = asRecord(params.response);
      }
    };
    target.webContents.debugger.on("message", listener);
    try {
      await this.#cdp(target.webContents, "Network.enable", undefined, target.cdpSessionId);
      await delay(duration);
    } finally {
      target.webContents.debugger.removeListener("message", listener);
      await this.#cdp(target.webContents, "Network.disable", undefined, target.cdpSessionId).catch(
        () => undefined,
      );
    }
    const entries = [...requests.values()].map((entry) => ({
      startedDateTime: entry.startedDateTime,
      time: 0,
      request: toHarRequest(entry.request ?? {}),
      response: toHarResponse(entry.response ?? {}),
      cache: {},
      timings: { send: 0, wait: 0, receive: 0 },
    }));
    await writeFileAtomically(
      outputPath,
      Buffer.from(
        JSON.stringify({
          log: { version: "1.2", creator: { name: "Penkra", version: "1" }, entries },
        }),
      ),
    );
    return { tabId, document, filename: outputPath, entries: entries.length };
  }

  async #captureTarget(target: AppTabObservationTarget): Promise<TabCapture> {
    const startedAt = performance.now();
    this.#perfCounters.capturePageCalls += 1;
    try {
      const bounds = await target.captureBounds?.();
      if (
        bounds === null ||
        (bounds &&
          (!isFiniteNumber(bounds.width) ||
            !isFiniteNumber(bounds.height) ||
            bounds.width <= 0 ||
            bounds.height <= 0))
      ) {
        throw observerError(
          "SCREENSHOT_NEVER_PAINTED",
          `${target.document} never painted.`,
        );
      }
      let image;
      try {
        image = await target.webContents.capturePage(bounds);
      } catch (error) {
        throw observerError(
          "SCREENSHOT_NEVER_PAINTED",
          `${target.document} never painted: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const size = image.getSize();
      const bytes = image.toPNG();
      this.#perfCounters.capturePageBytes += bytes.byteLength;
      return {
        bytes,
        cssWidth: size.width,
        cssHeight: size.height,
      };
    } finally {
      this.#perfCounters.capturePageTotalMs += performance.now() - startedAt;
    }
  }

  async click(tabId: string, reference: string, observe = false, human = false): Promise<unknown> {
    const { target, node } = await this.#referencedTarget(tabId, reference);
    const point = await this.#nodeCenter(target, node.backendNodeId);
    await this.#moveCursor(target, point, human);
    await this.#cdp(
      target.webContents,
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        button: "left",
        clickCount: 1,
        ...point,
      },
      target.cdpSessionId,
    );
    await this.#cdp(
      target.webContents,
      "Input.dispatchMouseEvent",
      {
        type: "mouseReleased",
        button: "left",
        clickCount: 1,
        ...point,
      },
      target.cdpSessionId,
    );
    return this.#actionResult(
      tabId,
      { tabId, target: reference, clicked: true },
      observe,
      referenceDocument(reference),
    );
  }

  async hover(tabId: string, reference: string, observe = false, human = false): Promise<unknown> {
    const { target, node } = await this.#referencedTarget(tabId, reference);
    const point = await this.#nodeCenter(target, node.backendNodeId);
    await this.#moveCursor(target, point, human);
    return this.#actionResult(
      tabId,
      { tabId, target: reference, hovered: true },
      observe,
      referenceDocument(reference),
    );
  }

  async type(
    tabId: string,
    reference: string,
    text: string,
    observe = false,
    human = false,
  ): Promise<unknown> {
    const { target, node } = await this.#referencedTarget(tabId, reference);
    const point = await this.#nodeCenter(target, node.backendNodeId);
    await this.#moveCursor(target, point, human);
    await this.#cdp(
      target.webContents,
      "Input.dispatchMouseEvent",
      { type: "mousePressed", button: "left", clickCount: 1, ...point },
      target.cdpSessionId,
    );
    await this.#cdp(
      target.webContents,
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", button: "left", clickCount: 1, ...point },
      target.cdpSessionId,
    );
    const objectId = await this.#resolveObject(target, node.backendNodeId);
    await this.#cdp(
      target.webContents,
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: `function(value) {
        this.focus();
        if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
          const prototype = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
          if (setter) setter.call(this, value); else this.value = value;
        } else if (this.isContentEditable) {
          this.textContent = value;
        } else {
          throw new Error("Target is not an editable control.");
        }
        this.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
      }`,
        arguments: [{ value: text }],
        awaitPromise: true,
        returnByValue: true,
      },
      target.cdpSessionId,
    );
    return this.#actionResult(
      tabId,
      { tabId, target: reference, typed: true, characters: text.length },
      observe,
      referenceDocument(reference),
    );
  }

  async highlight(tabId: string, reference: string): Promise<unknown> {
    const { target, node } = await this.#referencedTarget(tabId, reference);
    const objectId = await this.#resolveObject(target, node.backendNodeId);
    await this.#cdp(
      target.webContents,
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: `function() {
          const outline = this.style.outline;
          const offset = this.style.outlineOffset;
          this.style.outline = "2px solid #ef4444";
          this.style.outlineOffset = "2px";
          setTimeout(() => { this.style.outline = outline; this.style.outlineOffset = offset; }, 3000);
        }`,
        returnByValue: true,
      },
      target.cdpSessionId,
    );
    return { tabId, target: reference, highlighted: true, durationMs: 3_000 };
  }

  async press(
    tabId: string,
    key: string,
    observe = false,
    document: AppTabDocument = "d1",
  ): Promise<unknown> {
    const target = await this.#target(tabId, document);
    const normalized = bounded(key, 100);
    const definition = appTabKeyDefinition(normalized);
    const { text: _text, ...released } = definition;
    await this.#cdp(
      target.webContents,
      "Input.dispatchKeyEvent",
      { type: "keyDown", ...definition },
      target.cdpSessionId,
    );
    await this.#cdp(
      target.webContents,
      "Input.dispatchKeyEvent",
      { type: "keyUp", ...released },
      target.cdpSessionId,
    );
    return this.#actionResult(
      tabId,
      { tabId, key: normalized, pressed: true },
      observe,
      document,
    );
  }

  async select(tabId: string, reference: string, value: string, observe = false): Promise<unknown> {
    const { target, node } = await this.#referencedTarget(tabId, reference);
    const objectId = await this.#resolveObject(target, node.backendNodeId);
    await this.#cdp(
      target.webContents,
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: `function(value) {
        if (!(this instanceof HTMLSelectElement)) throw new Error("Target is not a select control.");
        this.value = value;
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
      }`,
        arguments: [{ value }],
        awaitPromise: true,
        returnByValue: true,
      },
      target.cdpSessionId,
    );
    return this.#actionResult(
      tabId,
      { tabId, target: reference, value, selected: true },
      observe,
      referenceDocument(reference),
    );
  }

  async scroll(
    tabId: string,
    deltaX: number,
    deltaY: number,
    observe = false,
    document: AppTabDocument = "d1",
  ): Promise<unknown> {
    const target = await this.#target(tabId, document);
    await this.#execute(
      target,
      `window.scrollBy(${JSON.stringify(deltaX)}, ${JSON.stringify(deltaY)})`,
      true,
    );
    return this.#actionResult(
      tabId,
      { tabId, deltaX, deltaY, scrolled: true },
      observe,
      document,
    );
  }

  async handleDialog(tabId: string, accept: boolean, text?: string): Promise<unknown> {
    const pending = this.#pendingDialogs.get(tabId);
    if (!pending) {
      throw new Error("No browser JavaScript dialog has been reported for this tab.");
    }
    const target = pending.target;
    await this.#cdp(
      target.webContents,
      "Page.handleJavaScriptDialog",
      {
        accept,
        ...(text === undefined ? {} : { promptText: bounded(text) }),
      },
      target.cdpSessionId,
    );
    this.#pendingDialogs.delete(tabId);
    return {
      tabId,
      accepted: accept,
      dialog: dialogResult(pending),
      ...(text === undefined ? {} : { promptText: bounded(text) }),
    };
  }

  async upload(tabId: string, reference: string, paths: ReadonlyArray<string>): Promise<unknown> {
    if (paths.length === 0)
      throw new Error("At least one path is required.");
    const { target, node } = await this.#referencedTarget(tabId, reference);
    const validatedPaths = this.#resolver.validateUploadPaths
      ? await this.#resolver.validateUploadPaths(target.descriptor, paths)
      : paths;
    await this.#cdp(
      target.webContents,
      "DOM.setFileInputFiles",
      {
        files: [...validatedPaths],
        backendNodeId: node.backendNodeId,
      },
      target.cdpSessionId,
    );
    return { tabId, target: reference, uploaded: validatedPaths.length };
  }

  async wait(
    tabId: string,
    text: string,
    timeoutMs: number,
    document: AppTabDocument = "d1",
  ): Promise<unknown> {
    const boundedTimeout = Math.min(MAX_WAIT_MS, Math.max(1, timeoutMs));
    const deadline = Date.now() + boundedTimeout;
    while (Date.now() <= deadline) {
      const target = await this.#target(tabId, document);
      const found = await this.#execute(
        target,
        `(document.body?.innerText ?? "").includes(${JSON.stringify(text)})`,
        true,
      );
      if (found === true) return { tabId, text, found: true };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Text did not appear within ${boundedTimeout} ms.`);
  }

  async #actionResult(
    tabId: string,
    action: Record<string, unknown>,
    observe: boolean,
    document: AppTabDocument,
  ): Promise<unknown> {
    const dialog = this.#pendingDialogs.get(tabId);
    if (dialog) return { ...action, dialog: dialogResult(dialog) };
    if (!observe) return action;
    return { ...action, observation: await this.snapshot(tabId, { document }) };
  }

  async #target(
    tabId: string,
    document: AppTabDocument = "d1",
    allowDialog = false,
  ): Promise<AppTabObservationTarget> {
    const existingDialog = this.#pendingDialogs.get(tabId);
    if (existingDialog && !allowDialog) {
      throw new Error(`A browser JavaScript ${existingDialog.type} dialog is open: ${JSON.stringify(bounded(existingDialog.message))}. Handle it with a dialog step in penkra tabs act before continuing.`);
    }
    const surfaceId = this.#surface.getStore();
    const resolved = await (surfaceId === undefined
      ? this.#resolver.resolve(tabId, document)
      : this.#resolver.resolve(tabId, document, surfaceId));
    const target: AppTabObservationTarget = { ...resolved, document: resolved.document ?? document };
    if (target.webContents.isDestroyed())
      throw observerError("TAB_GONE", `App tab ${tabId} is gone.`);
    if (existingDialog) return target;
    await this.#observeDialogs(tabId, target);
    const pending = this.#pendingDialogs.get(tabId);
    if (pending && !allowDialog) {
      throw new Error(`A browser JavaScript ${pending.type} dialog is open: ${JSON.stringify(bounded(pending.message))}. Handle it with a dialog step in penkra tabs act before continuing.`);
    }
    return target;
  }

  async #observeDialogs(tabId: string, target: AppTabObservationTarget): Promise<void> {
    const contents = target.webContents;
    const contentsId = contents.id;
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    const tabs = this.#dialogTabsByContents.get(contentsId) ?? new Set<string>();
    tabs.add(tabId);
    this.#dialogTabsByContents.set(contentsId, tabs);
    this.#dialogTargets.set(dialogTargetKey(contentsId, target.cdpSessionId), { tabId, target });
    const url = contents.getURL();
    if (url) this.#dialogTargets.set(dialogUrlKey(contentsId, url), { tabId, target });
    if (!this.#dialogListeners.has(contentsId)) {
      this.#dialogListeners.add(contentsId);
      const debuggerDetached = () => {
        // DevTools or Chromium can detach the root debugger without emitting one child-target
        // event per flattened session. Every cached child session is invalid after that boundary.
        this.#forgetProtocolSessions(contentsId);
      };
      contents.debugger.on("detach", debuggerDetached);
      contents.debugger.on("message", (_event, method, params, sessionId) => {
        if (method === "Target.detachedFromTarget" && isRecord(params)) {
          const detachedSessionId =
            typeof params.sessionId === "string" ? params.sessionId : sessionId;
          const detachedTargetId =
            typeof params.targetId === "string" ? params.targetId : undefined;
          this.#forgetProtocolSessions(contentsId, detachedTargetId, detachedSessionId);
          return;
        }
        if (method !== "Page.javascriptDialogOpening" || !isRecord(params)) return;
        const url = typeof params.url === "string" ? params.url : "";
        const owner =
          this.#dialogTargets.get(dialogTargetKey(contentsId, sessionId)) ??
          (url ? this.#dialogTargets.get(dialogUrlKey(contentsId, url)) : undefined) ??
          singleDialogOwner(
            this.#dialogTabsByContents.get(contentsId),
            this.#dialogTargets,
            contentsId,
          );
        if (!owner) return;
        this.#pendingDialogs.set(owner.tabId, {
          type: typeof params.type === "string" ? params.type : "dialog",
          message: typeof params.message === "string" ? params.message : "",
          url,
          defaultPrompt: typeof params.defaultPrompt === "string" ? params.defaultPrompt : "",
          target: owner.target,
        });
      });
      contents.once("destroyed", () => {
        this.#dialogListeners.delete(contentsId);
        this.#dialogTabsByContents.delete(contentsId);
        this.#forgetProtocolSessions(contentsId);
        for (const [key, owner] of this.#dialogTargets) {
          if (owner.target.webContents === contents) this.#dialogTargets.delete(key);
        }
        for (const [ownerTabId, dialog] of this.#pendingDialogs) {
          if (dialog.target.webContents === contents) this.#pendingDialogs.delete(ownerTabId);
        }
      });
    }
    await this.#cdp(contents, "Page.enable", undefined, target.cdpSessionId);
  }

  async #ensureCursor(target: AppTabObservationTarget): Promise<void> {
    const key = observationTargetKey(target);
    const loaderId = await this.#loaderId(target);
    if (!this.#cursorInstallations.has(key)) {
      const instanceId = randomUUID();
      const worldName = `penkra-agent-cursor-${instanceId}`;
      const response = asRecord(
        await this.#cdp(
          target.webContents,
          "Page.addScriptToEvaluateOnNewDocument",
          { source: AGENT_CURSOR_SOURCE, worldName, runImmediately: true },
          target.cdpSessionId,
        ),
      );
      let installation: CursorInstallation;
      const destroyedListener = () => {
        if (this.#cursorInstallations.get(key) !== installation) return;
        this.#forgetCursor(key, installation, "web-contents-destroyed");
      };
      installation = {
        destroyedListener,
        instanceId,
        ownerThreadId: null,
        ownerThreadWasActive: false,
        scriptId: typeof response.identifier === "string" ? response.identifier : null,
        target,
        worldName,
      };
      this.#cursorInstallations.set(key, installation);
      this.#cursorLog("installed", key, installation, { loaderId });
      target.webContents.once("destroyed", destroyedListener);
    }
    if (this.#cursorLoaders.get(key) === loaderId) return;
    this.#cursorLoaders.set(key, loaderId);
    this.#cursorLog("loader-ready", key, this.#cursorInstallations.get(key), { loaderId });
  }

  async #hideActiveCursor(reason: string): Promise<void> {
    const key = this.#activeCursorKey;
    if (!key) return;
    const installation = this.#cursorInstallations.get(key);
    this.#activeCursorKey = null;
    if (!installation || installation.target.webContents.isDestroyed()) return;
    try {
      await this.#evaluateCursor(
        installation,
        "globalThis.__agentBrowserRecordingCursorHide?.()",
      );
      this.#cursorLog("hidden", key, installation, { reason });
    } catch (error) {
      this.#cursorLog("hide-failed", key, installation, {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #removeCursor(
    key: string,
    installation: CursorInstallation,
    reason: string,
  ): Promise<void> {
    if (!installation.target.webContents.isDestroyed()) {
      await this.#evaluateCursor(
        installation,
        "globalThis.__agentBrowserRecordingCursorCleanup?.()",
      ).catch(() => undefined);
      if (installation.scriptId) {
        await this.#cdp(
          installation.target.webContents,
          "Page.removeScriptToEvaluateOnNewDocument",
          { identifier: installation.scriptId },
          installation.target.cdpSessionId,
        ).catch(() => undefined);
      }
    }
    this.#forgetCursor(key, installation, reason);
  }

  async #removeCursorsForTab(tabId: string, reason: string): Promise<void> {
    const removals: Array<Promise<void>> = [];
    for (const [key, installation] of this.#cursorInstallations) {
      if (installation.target.descriptor.id !== tabId) continue;
      removals.push(this.#removeCursor(key, installation, reason));
    }
    await Promise.all(removals);
  }

  async #evaluateCursor(installation: CursorInstallation, expression: string): Promise<unknown> {
    const target = installation.target;
    const frameTree = asRecord(
      await this.#cdp(target.webContents, "Page.getFrameTree", undefined, target.cdpSessionId),
    );
    const frame = asRecord(asRecord(frameTree.frameTree).frame);
    if (typeof frame.id !== "string" || !frame.id) {
      throw observerError("LOAD_FAILED", `${target.document} has no cursor frame.`);
    }
    const isolatedWorld = asRecord(
      await this.#cdp(
        target.webContents,
        "Page.createIsolatedWorld",
        { frameId: frame.id, worldName: installation.worldName },
        target.cdpSessionId,
      ),
    );
    if (typeof isolatedWorld.executionContextId !== "number") {
      throw observerError("LOAD_FAILED", `${target.document} has no cursor execution context.`);
    }
    return this.#cdp(
      target.webContents,
      "Runtime.evaluate",
      {
        contextId: isolatedWorld.executionContextId,
        expression,
        awaitPromise: true,
      },
      target.cdpSessionId,
    );
  }

  #forgetCursor(key: string, installation: CursorInstallation, reason: string): void {
    if (this.#cursorInstallations.get(key) !== installation) return;
    this.#cursorInstallations.delete(key);
    if (!installation.target.webContents.isDestroyed()) {
      installation.target.webContents.removeListener("destroyed", installation.destroyedListener);
    }
    this.#cursorLoaders.delete(key);
    this.#cursorPositions.delete(key);
    if (this.#activeCursorKey === key) this.#activeCursorKey = null;
    this.#cursorLog("removed", key, installation, { reason });
  }

  #cursorLog(
    event: string,
    key: string,
    installation: CursorInstallation | undefined,
    detail: Record<string, unknown> = {},
  ): void {
    console.info(
      `[app-tab-agent-cursor] ${JSON.stringify({
        event,
        instanceId: installation?.instanceId ?? null,
        tabId: installation?.target.descriptor.id ?? null,
        document: installation?.target.document ?? null,
        webContentsId: safeWebContentsId(installation?.target.webContents),
        targetKey: key,
        ownerThreadId: installation?.ownerThreadId ?? null,
        ownerThreadWasActive: installation?.ownerThreadWasActive ?? false,
        ...detail,
      })}`,
    );
  }

  async #moveCursor(
    target: AppTabObservationTarget,
    destination: { x: number; y: number },
    human: boolean,
  ): Promise<void> {
    await this.#ensureCursor(target);
    const key = observationTargetKey(target);
    if (this.#activeCursorKey && this.#activeCursorKey !== key) {
      await this.#hideActiveCursor("target-switch");
    }
    this.#activeCursorKey = key;
    const installation = this.#cursorInstallations.get(key);
    const ownerThreadId = this.#cursorOwnerThread.getStore() ?? null;
    if (installation && ownerThreadId) {
      installation.ownerThreadId = ownerThreadId;
      installation.ownerThreadWasActive ||= this.#activeTurnThreadIds.has(ownerThreadId);
    }
    const start = this.#cursorPositions.get(key) ?? { x: 12, y: 12 };
    const steps = human ? 24 : 12;
    const duration = human ? 360 : 180;
    const dx = destination.x - start.x;
    const dy = destination.y - start.y;
    this.#cursorLog("move-started", key, installation, {
      from: start,
      to: destination,
      steps,
      durationMs: duration,
      inputMode: human ? "human" : "smooth",
    });
    for (let index = 1; index <= steps; index += 1) {
      const progress = index / steps;
      const eased = progress * progress * (3 - 2 * progress);
      const bend = human ? Math.sin(Math.PI * progress) * Math.min(24, Math.hypot(dx, dy) / 12) : 0;
      const length = Math.hypot(dx, dy) || 1;
      const x = start.x + dx * eased + (-dy / length) * bend;
      const y = start.y + dy * eased + (dx / length) * bend;
      await this.#cdp(
        target.webContents,
        "Input.dispatchMouseEvent",
        {
          type: "mouseMoved",
          x,
          y,
        },
        target.cdpSessionId,
      );
      if (index === 1) {
        this.#cursorLog("shown", key, installation, { at: { x, y } });
      }
      await delay(duration / steps);
    }
    this.#cursorPositions.set(key, destination);
    this.#cursorLog("move-completed", key, installation, { at: destination });
  }

  #state(tabId: string, target: AppTabObservationTarget, loaderId: string): TabSnapshotState {
    const contents = target.webContents;
    const targetKey = observationTargetKey(target);
    const stateKey = `${tabId}:${target.document}`;
    const existing = this.#states.get(stateKey);
    if (existing?.observedTargetKey === targetKey && existing.loaderId === loaderId) return existing;
    existing?.dispose();
    const cleanups: Array<() => void> = [];
    const state: TabSnapshotState = {
      document: target.document,
      loaderId,
      nextReference: 1,
      references: new Map<string, SnapshotReference>(),
      referenceByBackendNodeId: new Map<number, string>(),
      observedTargetKey: targetKey,
      lastSnapshot: null,
      lastSnapshotReferences: new Set(),
      dispose: () => {
        for (const cleanup of cleanups.splice(0)) cleanup();
      },
    };
    this.#states.set(stateKey, state);
    const observedContents = new Map<number, WebContents>([[contents.id, contents]]);
    for (const observed of observedContents.values()) {
      const invalidateState = () => {
        if (this.#states.get(stateKey) === state) {
          state.dispose();
          this.#states.delete(stateKey);
        }
      };
      observed.on("destroyed", invalidateState);
      observed.on("did-start-navigation", invalidateState);
      cleanups.push(() => {
        observed.removeListener("destroyed", invalidateState);
        observed.removeListener("did-start-navigation", invalidateState);
      });
    }
    return state;
  }

  async #referencedTarget(
    tabId: string,
    reference: string,
  ): Promise<{
    target: AppTabObservationTarget;
    node: SnapshotReference;
  }> {
    const document = referenceDocument(reference);
    const target = await this.#target(tabId, document);
    const state = this.#states.get(`${tabId}:${document}`);
    const targetKey = observationTargetKey(target);
    const loaderId = await this.#loaderId(target);
    if (!state || state.observedTargetKey !== targetKey || state.loaderId !== loaderId) {
      throw observerError(
        "STALE_REFERENCE",
        `Reference ${reference} does not belong to the current ${document} loader.`,
      );
    }
    const node = this.#reference(state, reference);
    return { target: node.target, node };
  }

  #reference(state: TabSnapshotState, reference: string): SnapshotReference {
    const node = state.references.get(reference);
    if (!node || node.loaderId !== state.loaderId) {
      throw observerError(
        "STALE_REFERENCE",
        `Reference ${reference} is stale.`,
      );
    }
    return node;
  }

  async #nodeBox(
    target: AppTabObservationTarget,
    backendNodeId: number,
  ): Promise<{ x: number; y: number; width: number; height: number } | null> {
    try {
      const response = asRecord(
        await this.#cdp(
          target.webContents,
          "DOM.getBoxModel",
          { backendNodeId },
          target.cdpSessionId,
        ),
      );
      const model = asRecord(response.model);
      const rawQuad = Array.isArray(model.border) ? model.border : model.content;
      const quad = Array.isArray(rawQuad) ? rawQuad.filter(isFiniteNumber) : [];
      if (quad.length < 8) return null;
      const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
      const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      return {
        x: roundBoxNumber(left),
        y: roundBoxNumber(top),
        width: roundBoxNumber(Math.max(...xs) - left),
        height: roundBoxNumber(Math.max(...ys) - top),
      };
    } catch (error) {
      if ((error as { code?: unknown }).code === "STALE_REFERENCE") return null;
      if (
        error instanceof Error &&
        /could not compute box model|no layout object|not visible/i.test(error.message)
      ) {
        return null;
      }
      throw error;
    }
  }

  async #nodeCenter(
    target: AppTabObservationTarget,
    backendNodeId: number,
  ): Promise<{ x: number; y: number }> {
    const response = asRecord(
      await this.#cdp(
        target.webContents,
        "DOM.getBoxModel",
        { backendNodeId },
        target.cdpSessionId,
      ),
    );
    const model = asRecord(response.model);
    const quad = Array.isArray(model.content) ? model.content.filter(isFiniteNumber) : [];
    if (quad.length < 8)
      throw observerError("STALE_REFERENCE", "The referenced element has no visible box.");
    const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
    const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
    return {
      x: xs.reduce((sum, value) => sum + value, 0) / xs.length,
      y: ys.reduce((sum, value) => sum + value, 0) / ys.length,
    };
  }

  async #resolveObject(target: AppTabObservationTarget, backendNodeId: number): Promise<string> {
    const response = asRecord(
      await this.#cdp(
        target.webContents,
        "DOM.resolveNode",
        { backendNodeId },
        target.cdpSessionId,
      ),
    );
    const object = asRecord(response.object);
    if (typeof object.objectId !== "string") {
      throw observerError("STALE_REFERENCE", "The referenced element no longer exists.");
    }
    return object.objectId;
  }

  async #loaderId(target: AppTabObservationTarget): Promise<string> {
    const response = asRecord(
      await this.#cdp(
        target.webContents,
        "Page.getFrameTree",
        undefined,
        target.cdpSessionId,
      ),
    );
    const frame = asRecord(asRecord(response.frameTree).frame);
    if (typeof frame.loaderId !== "string" || !frame.loaderId) {
      throw observerError("LOAD_FAILED", `${target.document} has no committed loader.`);
    }
    return frame.loaderId;
  }

  async #cdp(
    contents: WebContents,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    const startedAt = performance.now();
    this.#perfCounters.cdpCalls += 1;
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    try {
      return sessionId === undefined
        ? await contents.debugger.sendCommand(method, params)
        : await contents.debugger.sendCommand(method, params, sessionId);
    } catch (error) {
      if (sessionId !== undefined) {
        this.#forgetProtocolSessions(contents.id, undefined, sessionId);
      }
      if (error instanceof Error && /node|object|context|target|document/i.test(error.message)) {
        throw observerError("STALE_REFERENCE", error.message);
      }
      throw error;
    } finally {
      this.#perfCounters.cdpTotalMs += performance.now() - startedAt;
    }
  }

  #forgetProtocolSessions(contentsId: number, targetId?: string, sessionId?: string): void {
    for (const [key, session] of this.#protocolSessions) {
      if (
        session.contentsId === contentsId &&
        (targetId === undefined || session.targetId === targetId) &&
        (sessionId === undefined || session.sessionId === sessionId)
      ) {
        this.#protocolSessions.delete(key);
      }
    }
  }

  #execute(
    target: AppTabObservationTarget,
    source: string,
    userGesture: boolean,
  ): Promise<unknown> {
    return target.webContents.executeJavaScript(source, userGesture);
  }
}

function cdpText(value: CdpValue | undefined): string {
  if (typeof value?.value === "string") return value.value;
  if (typeof value?.value === "number" || typeof value?.value === "boolean")
    return String(value.value);
  return "";
}

function normalizeAxRole(value: string): string {
  if (!value) return "generic";
  if (value === "RootWebArea" || value === "WebArea") return "document";
  if (value === "StaticText" || value === "InlineTextBox") return "text";
  return value;
}

function axProperties(properties: CdpAxProperty[] | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const property of properties ?? []) {
    if (typeof property.name !== "string" || property.value?.value === undefined) continue;
    result[property.name] = property.value.value;
  }
  return result;
}

function isProtectedValue(
  role: string,
  properties: Record<string, unknown>,
  value: string,
): boolean {
  return (
    (role === "textbox" || role === "searchbox") &&
    (properties.protected === true || /^[•●*]+$/.test(value))
  );
}

function bounded(value: string, maximum = MAX_VALUE_LENGTH): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? (value as Record<string, unknown>) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

async function compositePng(
  base: TabCapture,
  overlay: TabCapture,
  insets: { top: number; right: number; bottom: number; left: number },
): Promise<Buffer> {
  const { nativeImage } = await import("electron");
  const baseImage = nativeImage.createFromBuffer(base.bytes);
  const baseSize = baseImage.getSize();
  const left = Math.round((insets.left / base.cssWidth) * baseSize.width);
  const right = Math.round((insets.right / base.cssWidth) * baseSize.width);
  const top = Math.round((insets.top / base.cssHeight) * baseSize.height);
  const bottom = Math.round((insets.bottom / base.cssHeight) * baseSize.height);
  const width = baseSize.width - left - right;
  const height = baseSize.height - top - bottom;
  if (width <= 0 || height <= 0) {
    throw observerError("SCREENSHOT_NEVER_PAINTED", "The hosted-page rectangle is outside the App capture.");
  }
  const overlayImage = nativeImage.createFromBuffer(overlay.bytes).resize({ width, height });
  const baseBitmap = Buffer.from(baseImage.toBitmap());
  const overlayBitmap = overlayImage.toBitmap();
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const source = (row * width + column) * 4;
      const destination = ((top + row) * baseSize.width + left + column) * 4;
      const alpha = overlayBitmap[source + 3]! / 255;
      for (let channel = 0; channel < 3; channel += 1) {
        baseBitmap[destination + channel] = Math.round(
          overlayBitmap[source + channel]! * alpha +
            baseBitmap[destination + channel]! * (1 - alpha),
        );
      }
      baseBitmap[destination + 3] = Math.round(
        overlayBitmap[source + 3]! + baseBitmap[destination + 3]! * (1 - alpha),
      );
    }
  }
  return nativeImage
    .createFromBitmap(baseBitmap, {
      width: baseSize.width,
      height: baseSize.height,
    })
    .toPNG();
}

function normalizeDepth(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("Snapshot depth must be a non-negative integer.");
  }
  return value;
}

function roundBoxNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function compileFindPattern(query: string): RegExp {
  if (!query)
    throw new Error("Find requires text or a regular expression.");
  if (query.startsWith("/") && query.lastIndexOf("/") > 0) {
    const closingSlash = query.lastIndexOf("/");
    try {
      return new RegExp(query.slice(1, closingSlash), query.slice(closingSlash + 1));
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "The regular expression is invalid.");
    }
  }
  return new RegExp(escapeRegExp(query), "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function observationTargetKey(target: AppTabObservationTarget): string {
  return `${target.document}:${target.webContents.id}:${target.cdpSessionId ?? "top"}`;
}

function safeWebContentsId(contents: WebContents | undefined): number | null {
  if (!contents || contents.isDestroyed()) return null;
  try {
    return contents.id;
  } catch {
    return null;
  }
}

function referenceDocument(reference: string): AppTabDocument {
  const match = /^(d[12]):e[0-9]+$/.exec(reference);
  if (!match) throw observerError("STALE_REFERENCE", `Reference ${reference} is stale.`);
  return match[1] as AppTabDocument;
}

function sameProtocolTarget(
  left: AppTabObservationTarget,
  right: AppTabObservationTarget,
): boolean {
  if (left.webContents.id !== right.webContents.id) return false;
  return (left.cdpSessionId ?? null) === (right.cdpSessionId ?? null);
}

function observerError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function referenceOrder(left: string, right: string): number {
  return Number(left.match(/e(\d+)$/)?.[1] ?? 0) - Number(right.match(/e(\d+)$/)?.[1] ?? 0);
}

function referenceLine(snapshot: string, reference: string): string {
  return snapshot.split("\n").find((line) => line.includes(`ref=${reference}`)) ?? "";
}

function referenceRole(snapshot: string, reference: string): string {
  return /^\s*-\s+(\S+)/.exec(referenceLine(snapshot, reference))?.[1] ?? "generic";
}

function referenceName(snapshot: string, reference: string): string {
  const match = /^\s*-\s+\S+\s+("(?:[^"\\]|\\.)*")/.exec(referenceLine(snapshot, reference));
  if (!match) return "";
  try {
    return JSON.parse(match[1]!) as string;
  } catch {
    return "";
  }
}

function recordingFfmpegArguments(outputPath: string, extension: string): string[] {
  const codec =
    extension === ".mp4"
      ? ["-c:v", "libx264", "-preset", "veryfast", "-movflags", "+faststart"]
      : ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "6"];
  return [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "image2pipe",
    "-framerate",
    "30",
    "-vcodec",
    "mjpeg",
    "-i",
    "pipe:0",
    "-an",
    ...codec,
    "-pix_fmt",
    "yuv420p",
    outputPath,
  ];
}

function resolveFfmpegExecutable(): string {
  const executable = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidates = [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, executable)),
    ...(process.platform === "darwin"
      ? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]
      : []),
  ];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) throw new Error("ffmpeg is required to record App tab video.");
  return resolved;
}

function boundedDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 1_000;
  return Math.min(30_000, Math.max(0, Math.round(value)));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function headerList(value: unknown): Array<{ name: string; value: string }> {
  if (!isRecord(value)) return [];
  return Object.entries(value).map(([name, headerValue]) => ({
    name,
    value: typeof headerValue === "string" ? headerValue : String(headerValue),
  }));
}

function toHarRequest(request: Record<string, unknown>): Record<string, unknown> {
  return {
    method: typeof request.method === "string" ? request.method : "GET",
    url: typeof request.url === "string" ? request.url : "",
    httpVersion: "HTTP/1.1",
    headers: headerList(request.headers),
    queryString: [],
    cookies: [],
    headersSize: -1,
    bodySize: typeof request.postData === "string" ? Buffer.byteLength(request.postData) : 0,
    ...(typeof request.postData === "string"
      ? { postData: { mimeType: "application/octet-stream", text: request.postData } }
      : {}),
  };
}

function toHarResponse(response: Record<string, unknown>): Record<string, unknown> {
  return {
    status: typeof response.status === "number" ? response.status : 0,
    statusText: typeof response.statusText === "string" ? response.statusText : "",
    httpVersion: typeof response.protocol === "string" ? response.protocol : "HTTP/1.1",
    headers: headerList(response.headers),
    cookies: [],
    content: {
      size: typeof response.encodedDataLength === "number" ? response.encodedDataLength : 0,
      mimeType: typeof response.mimeType === "string" ? response.mimeType : "",
    },
    redirectURL: "",
    headersSize: -1,
    bodySize: typeof response.encodedDataLength === "number" ? response.encodedDataLength : -1,
  };
}

function dialogTargetKey(contentsId: number, sessionId: unknown): string {
  return `${contentsId}:session:${typeof sessionId === "string" ? sessionId : "top"}`;
}

function dialogUrlKey(contentsId: number, url: string): string {
  return `${contentsId}:url:${withoutHash(url)}`;
}

function withoutHash(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value.split("#", 1)[0] ?? value;
  }
}

function singleDialogOwner(
  tabIds: ReadonlySet<string> | undefined,
  targets: ReadonlyMap<string, { tabId: string; target: AppTabObservationTarget }>,
  contentsId: number,
): { tabId: string; target: AppTabObservationTarget } | undefined {
  if (!tabIds || tabIds.size !== 1) return undefined;
  return targets.get(dialogTargetKey(contentsId, undefined));
}

function dialogResult(dialog: PendingJavaScriptDialog): {
  type: string;
  message: string;
  url: string;
  defaultPrompt: string;
} {
  return {
    type: dialog.type,
    message: bounded(dialog.message),
    url: dialog.url,
    defaultPrompt: bounded(dialog.defaultPrompt),
  };
}

async function writeFileAtomically(path: string, contents: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
