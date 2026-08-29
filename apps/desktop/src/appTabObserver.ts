// FILE: appTabObserver.ts
// Purpose: Provides the trusted, host-only semantic observer for isolated App-tab WebContents.
// Layer: Desktop agent capability bridge (never exposed through the App SDK)

import type { Rectangle, WebContents, WebFrameMain } from "electron";
import type { DesktopAppTabDescriptor } from "@penkra/contracts";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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

interface CdpFrameTree {
  frame?: { id?: string; url?: string };
  childFrames?: CdpFrameTree[];
}

interface SnapshotReference {
  backendNodeId: number;
  generation: number;
  target: AppTabObservationTarget;
}

interface TabSnapshotState {
  generation: number;
  nextReference: number;
  references: Map<string, SnapshotReference>;
  observedTargetKey: string;
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

export interface AppTabObservationTarget {
  descriptor: DesktopAppTabDescriptor;
  webContents: WebContents;
  frame?: WebFrameMain;
  cdpSessionId?: string;
  /** Null means the shell is not currently painting this tab. */
  captureBounds?: () => Promise<Rectangle | null> | Rectangle | null;
  embedded?: {
    target: AppTabObservationTarget;
    insets: { top: number; right: number; bottom: number; left: number };
  };
}

export interface AppTabObserverResolver {
  resolve(tabId: string): Promise<AppTabObservationTarget> | AppTabObservationTarget;
  validateUploadPaths?(
    descriptor: DesktopAppTabDescriptor,
    paths: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<string>>;
}

export async function resolveAppTabObservationTarget(input: {
  descriptor: DesktopAppTabDescriptor;
  browserAppId: string;
  allowHostedPage?: boolean;
  hostedInsets?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  } | null;
  appTarget: (tabId: string) => Promise<AppTabObservationTarget> | AppTabObservationTarget;
  browserWebContents: (appTabId: string) => Promise<WebContents | null>;
  hostedWebContents?: (appTabId: string) => WebContents | null;
}): Promise<AppTabObservationTarget> {
  const hostedSurface = input.hostedWebContents?.(input.descriptor.id) ?? null;
  const hostedPage =
    !hostedSurface &&
    (input.allowHostedPage === true || input.descriptor.appId === input.browserAppId)
      ? await input.browserWebContents(input.descriptor.id)
      : null;
  if (hostedSurface || hostedPage) {
    const hostedTarget = {
      descriptor: input.descriptor,
      webContents: hostedSurface ?? hostedPage!,
    };
    const insets = input.hostedInsets;
    if (
      insets &&
      [insets.top, insets.right, insets.bottom, insets.left].some((value) => value > 0)
    ) {
      const app = await input.appTarget(input.descriptor.id);
      return { ...app, embedded: { target: hostedTarget, insets } };
    }
    return hostedTarget;
  }
  return input.appTarget(input.descriptor.id);
}

export class AppTabObserver {
  readonly #resolver: AppTabObserverResolver;
  readonly #states = new Map<string, TabSnapshotState>();
  readonly #protocolSessions = new Map<string, string>();
  readonly #dialogTargets = new Map<string, { tabId: string; target: AppTabObservationTarget }>();
  readonly #dialogTabsByContents = new Map<number, Set<string>>();
  readonly #dialogListeners = new Set<number>();
  readonly #pendingDialogs = new Map<string, PendingJavaScriptDialog>();

  constructor(resolver: AppTabObserverResolver) {
    this.#resolver = resolver;
  }

  invalidate(tabId: string): void {
    const state = this.#states.get(tabId);
    state?.dispose();
    this.#states.delete(tabId);
    this.#pendingDialogs.delete(tabId);
    for (const [key, owner] of this.#dialogTargets) {
      if (owner.tabId === tabId) this.#dialogTargets.delete(key);
    }
    for (const [contentsId, tabIds] of this.#dialogTabsByContents) {
      tabIds.delete(tabId);
      if (tabIds.size === 0) this.#dialogTabsByContents.delete(contentsId);
    }
  }

  async snapshot(
    tabId: string,
    options: {
      target?: string;
      depth?: number;
      boxes?: boolean;
      outputPath?: string;
    } = {},
  ): Promise<unknown> {
    const target = await this.#target(tabId);
    const state = this.#state(tabId, target);
    const scopedReference =
      options.target === undefined ? undefined : this.#reference(state, options.target);
    state.generation += 1;
    state.nextReference = 1;
    state.references.clear();
    const depth = options.depth === undefined ? undefined : normalizeDepth(options.depth);
    const appTree =
      scopedReference && !sameProtocolTarget(scopedReference.target, target)
        ? []
        : await this.#snapshotLines(
            target,
            state,
            scopedReference?.backendNodeId,
            depth,
            options.boxes === true,
          );
    const embeddedTree =
      target.embedded &&
      (!scopedReference || sameProtocolTarget(scopedReference.target, target.embedded.target))
        ? await this.#snapshotLines(
            target.embedded.target,
            state,
            scopedReference?.backendNodeId,
            depth,
            options.boxes === true,
          )
        : [];
    const lines = [...appTree];
    if (embeddedTree.length > 0) {
      lines.push('- document "Hosted page"');
      lines.push(...embeddedTree.map((line) => `  ${line}`));
    }

    const result = {
      tabId,
      app: target.descriptor.slug,
      url: target.frame?.url ?? target.webContents.getURL(),
      title: target.frame
        ? String(await target.frame.executeJavaScript("document.title", true))
        : target.webContents.getTitle(),
      snapshot: lines.join("\n"),
    };
    if (!options.outputPath) return result;
    await writeFileAtomically(options.outputPath, Buffer.from(`${result.snapshot}\n`, "utf8"));
    const { snapshot: _snapshot, ...metadata } = result;
    return { ...metadata, filename: options.outputPath };
  }

  async #snapshotLines(
    target: AppTabObservationTarget,
    state: TabSnapshotState,
    backendNodeId: number | undefined,
    maxDepth: number | undefined,
    includeBoxes: boolean,
  ): Promise<string[]> {
    const protocol = target.frame ? await this.#protocolTarget(target) : { target };
    const response = asRecord(
      await this.#cdp(
        protocol.target.webContents,
        backendNodeId === undefined
          ? "Accessibility.getFullAXTree"
          : "Accessibility.getPartialAXTree",
        backendNodeId === undefined
          ? protocol.frameId
            ? { frameId: protocol.frameId }
            : undefined
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
    const visited = new Set<CdpAxNode>();
    const visit = async (raw: CdpAxNode, depth: number): Promise<void> => {
      if (visited.has(raw)) return;
      visited.add(raw);
      if (maxDepth !== undefined && depth > maxDepth) return;
      const children = (raw.childIds ?? []).flatMap((id) => {
        const child = byId.get(id);
        return child ? [child] : [];
      });
      if (raw.ignored === true) {
        for (const child of children) await visit(child, depth);
        return;
      }
      const line = await this.#snapshotLine(protocol.target, raw, state, includeBoxes);
      if (line) lines.push(`${"  ".repeat(depth)}${line}`);
      const childDepth = line ? depth + 1 : depth;
      for (const child of children) await visit(child, childDepth);
    };
    for (const root of effectiveRoots) await visit(root, 0);
    // Older Chromium test doubles and partial trees may omit relationships. Preserve their
    // protocol order rather than dropping valid nodes.
    for (const raw of rawNodes) if (!visited.has(raw)) await visit(raw, 0);
    return lines;
  }

  async #protocolTarget(
    target: AppTabObservationTarget,
  ): Promise<{ target: AppTabObservationTarget; frameId?: string }> {
    const response = asRecord(await this.#cdp(target.webContents, "Page.getFrameTree"));
    const root = response.frameTree as CdpFrameTree | undefined;
    const expectedUrl = target.frame?.url;
    if (!root || !expectedUrl) throw new Error("The App frame is unavailable for observation.");
    const stack = [root];
    const frames: Array<{ id: string; url: string }> = [];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.frame?.url === expectedUrl && current.frame.id) {
        return { target, frameId: current.frame.id };
      }
      if (current.frame?.id && current.frame.url) {
        frames.push(current.frame as { id: string; url: string });
      }
      stack.push(...(current.childFrames ?? []));
    }
    const expectedDocumentUrl = withoutHash(expectedUrl);
    const documentMatches = frames.filter(
      (frame) => withoutHash(frame.url) === expectedDocumentUrl,
    );
    if (documentMatches.length === 1) return { target, frameId: documentMatches[0]!.id };

    const targetsResponse = asRecord(await this.#cdp(target.webContents, "Target.getTargets"));
    const targetInfos = Array.isArray(targetsResponse.targetInfos)
      ? targetsResponse.targetInfos.filter(isRecord)
      : [];
    const exactTargets = targetInfos.filter(
      (info) => info.url === expectedUrl && typeof info.targetId === "string",
    );
    const documentTargets = targetInfos.filter(
      (info) =>
        typeof info.url === "string" &&
        withoutHash(info.url) === expectedDocumentUrl &&
        typeof info.targetId === "string",
    );
    const matches = exactTargets.length > 0 ? exactTargets : documentTargets;
    if (matches.length === 1) {
      const targetId = matches[0]!.targetId as string;
      let sessionId = this.#protocolSessions.get(targetId);
      if (!sessionId) {
        const attached = asRecord(
          await this.#cdp(target.webContents, "Target.attachToTarget", {
            targetId,
            flatten: true,
          }),
        );
        if (typeof attached.sessionId !== "string") {
          throw new Error("Chrome did not return an App frame observation session.");
        }
        sessionId = attached.sessionId;
        this.#protocolSessions.set(targetId, sessionId);
      }
      return { target: { ...target, cdpSessionId: sessionId } };
    }
    throw new Error("The App frame is not present in the browser protocol frame tree.");
  }

  async #snapshotLine(
    target: AppTabObservationTarget,
    raw: CdpAxNode,
    state: TabSnapshotState,
    includeBox: boolean,
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
      reference = `e${state.nextReference++}`;
      state.references.set(reference, {
        backendNodeId: raw.backendDOMNodeId,
        generation: state.generation,
        target,
      });
    }
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

  async find(tabId: string, query: string): Promise<unknown> {
    const observation = (await this.snapshot(tabId)) as {
      tabId: string;
      app: string;
      url: string;
      title: string;
      snapshot: string;
    };
    const matcher = compileFindPattern(query);
    const lines = observation.snapshot.split("\n");
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

  async screenshot(tabId: string, outputPath?: string): Promise<unknown> {
    const target = await this.#target(tabId);
    let capture = await this.#captureTarget(target);
    if (target.embedded) {
      const embedded = await this.#captureTarget(target.embedded.target);
      capture = {
        ...capture,
        bytes: await compositePng(capture, embedded, target.embedded.insets),
      };
    }
    const bytes = capture.bytes;
    if (bytes.byteLength === 0)
      throw observerError("CAPTURE_FAILED", "The App tab capture was empty.");
    if (outputPath) {
      await writeFileAtomically(outputPath, bytes);
      return { tabId, filename: outputPath, mimeType: "image/png" };
    }
    if (bytes.byteLength > MAX_INLINE_SCREENSHOT_BYTES) {
      throw observerError(
        "CAPTURE_TOO_LARGE",
        "The PNG does not fit in the inline tool transport. Supply filename to save it instead.",
      );
    }
    return {
      kind: "image",
      mimeType: "image/png",
      data: bytes.toString("base64"),
    };
  }

  async #captureTarget(target: AppTabObservationTarget): Promise<TabCapture> {
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
        "TAB_NOT_VISIBLE",
        `App tab ${target.descriptor.id} is not the currently painted App surface.`,
      );
    }
    let image;
    try {
      image = await target.webContents.capturePage(bounds);
    } catch (error) {
      throw observerError(
        "TAB_NOT_VISIBLE",
        `App tab ${target.descriptor.id} does not currently have a paintable capture surface: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const size = image.getSize();
    return {
      bytes: image.toPNG(),
      cssWidth: size.width,
      cssHeight: size.height,
    };
  }

  async click(tabId: string, reference: string, observe = false): Promise<unknown> {
    const { target, node } = await this.#referencedTarget(tabId, reference);
    const point = await this.#nodeCenter(target, node.backendNodeId);
    await this.#cdp(
      target.webContents,
      "Input.dispatchMouseEvent",
      {
        type: "mouseMoved",
        ...point,
      },
      target.cdpSessionId,
    );
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
    return this.#actionResult(tabId, { tabId, target: reference, clicked: true }, observe);
  }

  async hover(tabId: string, reference: string, observe = false): Promise<unknown> {
    const { target, node } = await this.#referencedTarget(tabId, reference);
    const point = await this.#nodeCenter(target, node.backendNodeId);
    await this.#cdp(
      target.webContents,
      "Input.dispatchMouseEvent",
      {
        type: "mouseMoved",
        ...point,
      },
      target.cdpSessionId,
    );
    return this.#actionResult(tabId, { tabId, target: reference, hovered: true }, observe);
  }

  async type(tabId: string, reference: string, text: string, observe = false): Promise<unknown> {
    const { target, node } = await this.#referencedTarget(tabId, reference);
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
    );
  }

  async press(tabId: string, key: string, observe = false): Promise<unknown> {
    const sourceTarget = await this.#target(tabId);
    const target = sourceTarget.frame
      ? (await this.#protocolTarget(sourceTarget)).target
      : sourceTarget;
    const normalized = bounded(key, 100);
    await this.#cdp(
      target.webContents,
      "Input.dispatchKeyEvent",
      { type: "keyDown", key: normalized },
      target.cdpSessionId,
    );
    await this.#cdp(
      target.webContents,
      "Input.dispatchKeyEvent",
      { type: "keyUp", key: normalized },
      target.cdpSessionId,
    );
    return this.#actionResult(tabId, { tabId, key: normalized, pressed: true }, observe);
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
    return this.#actionResult(tabId, { tabId, target: reference, value, selected: true }, observe);
  }

  async scroll(tabId: string, deltaX: number, deltaY: number, observe = false): Promise<unknown> {
    const target = await this.#target(tabId);
    await this.#execute(
      target,
      `window.scrollBy(${JSON.stringify(deltaX)}, ${JSON.stringify(deltaY)})`,
      true,
    );
    return this.#actionResult(tabId, { tabId, deltaX, deltaY, scrolled: true }, observe);
  }

  async handleDialog(tabId: string, accept: boolean, text?: string): Promise<unknown> {
    await this.#target(tabId, true);
    const pending = this.#pendingDialogs.get(tabId);
    if (!pending) {
      throw observerError(
        "DIALOG_NOT_REPORTED",
        "No browser JavaScript dialog has been reported for this tab.",
      );
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
      throw observerError("UPLOAD_PATH_REQUIRED", "At least one path is required.");
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

  async wait(tabId: string, text: string, timeoutMs: number): Promise<unknown> {
    const boundedTimeout = Math.min(MAX_WAIT_MS, Math.max(1, timeoutMs));
    const deadline = Date.now() + boundedTimeout;
    while (Date.now() <= deadline) {
      const target = await this.#target(tabId);
      const found = await this.#execute(
        target,
        `(document.body?.innerText ?? "").includes(${JSON.stringify(text)})`,
        true,
      );
      if (found === true) return { tabId, text, found: true };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw observerError("WAIT_TIMED_OUT", `Text did not appear within ${boundedTimeout} ms.`);
  }

  async #actionResult(
    tabId: string,
    action: Record<string, unknown>,
    observe: boolean,
  ): Promise<unknown> {
    const dialog = this.#pendingDialogs.get(tabId);
    if (dialog) return { ...action, dialog: dialogResult(dialog) };
    if (!observe) return action;
    return { ...action, observation: await this.snapshot(tabId) };
  }

  async #target(tabId: string, allowDialog = false): Promise<AppTabObservationTarget> {
    const existingDialog = this.#pendingDialogs.get(tabId);
    if (existingDialog && !allowDialog) {
      throw observerError(
        "DIALOG_OPEN",
        `A browser JavaScript ${existingDialog.type} dialog is open: ${JSON.stringify(bounded(existingDialog.message))}. Handle it with penkra tabs handle-dialog before continuing.`,
      );
    }
    const target = await this.#resolver.resolve(tabId);
    if (target.webContents.isDestroyed())
      throw observerError("TAB_CLOSED", `App tab ${tabId} is closed.`);
    if (target.embedded?.target.webContents.isDestroyed())
      throw observerError("TAB_CLOSED", `Hosted page in App tab ${tabId} is closed.`);
    if (existingDialog) return target;
    await this.#observeDialogs(tabId, target);
    if (target.embedded) await this.#observeDialogs(tabId, target.embedded.target);
    const pending = this.#pendingDialogs.get(tabId);
    if (pending && !allowDialog) {
      throw observerError(
        "DIALOG_OPEN",
        `A browser JavaScript ${pending.type} dialog is open: ${JSON.stringify(bounded(pending.message))}. Handle it with penkra tabs handle-dialog before continuing.`,
      );
    }
    return target;
  }

  async #observeDialogs(tabId: string, target: AppTabObservationTarget): Promise<void> {
    const contents = target.webContents;
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    const tabs = this.#dialogTabsByContents.get(contents.id) ?? new Set<string>();
    tabs.add(tabId);
    this.#dialogTabsByContents.set(contents.id, tabs);
    this.#dialogTargets.set(dialogTargetKey(contents.id, target.cdpSessionId), { tabId, target });
    const url = target.frame?.url ?? contents.getURL();
    if (url) this.#dialogTargets.set(dialogUrlKey(contents.id, url), { tabId, target });
    if (!this.#dialogListeners.has(contents.id)) {
      this.#dialogListeners.add(contents.id);
      contents.debugger.on("message", (_event, method, params, sessionId) => {
        if (method !== "Page.javascriptDialogOpening" || !isRecord(params)) return;
        const url = typeof params.url === "string" ? params.url : "";
        const owner =
          this.#dialogTargets.get(dialogTargetKey(contents.id, sessionId)) ??
          (url ? this.#dialogTargets.get(dialogUrlKey(contents.id, url)) : undefined) ??
          singleDialogOwner(
            this.#dialogTabsByContents.get(contents.id),
            this.#dialogTargets,
            contents.id,
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
        this.#dialogListeners.delete(contents.id);
        this.#dialogTabsByContents.delete(contents.id);
      });
    }
    await this.#cdp(contents, "Page.enable", undefined, target.cdpSessionId);
  }

  #state(tabId: string, target: AppTabObservationTarget): TabSnapshotState {
    const contents = target.webContents;
    const targetKey = observationTargetKey(target);
    const existing = this.#states.get(tabId);
    if (existing?.observedTargetKey === targetKey) return existing;
    existing?.dispose();
    const cleanups: Array<() => void> = [];
    const state: TabSnapshotState = {
      generation: 0,
      nextReference: 1,
      references: new Map<string, SnapshotReference>(),
      observedTargetKey: targetKey,
      dispose: () => {
        for (const cleanup of cleanups.splice(0)) cleanup();
      },
    };
    this.#states.set(tabId, state);
    const observedContents = new Map<number, WebContents>([[contents.id, contents]]);
    if (target.embedded?.target.webContents) {
      observedContents.set(
        target.embedded.target.webContents.id,
        target.embedded.target.webContents,
      );
    }
    for (const observed of observedContents.values()) {
      const invalidateState = () => {
        if (this.#states.get(tabId) === state) this.invalidate(tabId);
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
    const target = await this.#target(tabId);
    const state = this.#states.get(tabId);
    const targetKey = observationTargetKey(target);
    if (!state || state.observedTargetKey !== targetKey) {
      throw observerError(
        "SNAPSHOT_REQUIRED",
        "Take a fresh tab snapshot before using a reference.",
      );
    }
    const node = this.#reference(state, reference);
    return { target: node.target, node };
  }

  #reference(state: TabSnapshotState, reference: string): SnapshotReference {
    const node = state.references.get(reference);
    if (!node || node.generation !== state.generation) {
      throw observerError(
        "STALE_REFERENCE",
        `Reference ${reference} is not in the latest tab snapshot.`,
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
      throw observerError("ELEMENT_NOT_VISIBLE", "The referenced element has no visible box.");
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

  async #cdp(
    contents: WebContents,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    try {
      return sessionId === undefined
        ? await contents.debugger.sendCommand(method, params)
        : await contents.debugger.sendCommand(method, params, sessionId);
    } catch (error) {
      if (error instanceof Error && /node|object|context|target|document/i.test(error.message)) {
        throw observerError("STALE_REFERENCE", error.message);
      }
      throw error;
    }
  }

  #execute(
    target: AppTabObservationTarget,
    source: string,
    userGesture: boolean,
  ): Promise<unknown> {
    return target.frame
      ? target.frame.executeJavaScript(source, userGesture)
      : target.webContents.executeJavaScript(source, userGesture);
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
    throw observerError("CAPTURE_FAILED", "The hosted-page rectangle is outside the App capture.");
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
    throw observerError("INVALID_DEPTH", "Snapshot depth must be a non-negative integer.");
  }
  return value;
}

function roundBoxNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function compileFindPattern(query: string): RegExp {
  if (!query)
    throw observerError("FIND_QUERY_REQUIRED", "Find requires text or a regular expression.");
  if (query.startsWith("/") && query.lastIndexOf("/") > 0) {
    const closingSlash = query.lastIndexOf("/");
    try {
      return new RegExp(query.slice(1, closingSlash), query.slice(closingSlash + 1));
    } catch (error) {
      throw observerError(
        "INVALID_FIND_PATTERN",
        error instanceof Error ? error.message : "The regular expression is invalid.",
      );
    }
  }
  return new RegExp(escapeRegExp(query), "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function observationTargetKey(target: AppTabObservationTarget): string {
  const primary = `${target.webContents.id}:${target.frame?.url ?? target.cdpSessionId ?? "top"}`;
  if (!target.embedded) return primary;
  const embedded = target.embedded.target;
  return `${primary}|${embedded.webContents.id}:${embedded.frame?.url ?? embedded.cdpSessionId ?? "top"}`;
}

function sameProtocolTarget(
  left: AppTabObservationTarget,
  right: AppTabObservationTarget,
): boolean {
  if (left.webContents.id !== right.webContents.id) return false;
  if (left.frame || right.frame) return left.frame?.url === right.frame?.url;
  return (left.cdpSessionId ?? null) === (right.cdpSessionId ?? null);
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

function observerError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function dialogTargetKey(contentsId: number, sessionId: unknown): string {
  return `${contentsId}:session:${typeof sessionId === "string" ? sessionId : "top"}`;
}

function dialogUrlKey(contentsId: number, url: string): string {
  return `${contentsId}:url:${withoutHash(url)}`;
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
