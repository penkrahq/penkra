// FILE: DiffPanelFileList.tsx
// Purpose: Multi-file diff list for the review panel, including per-file actions and previews.
// Layer: Diff panel UI

import type { FileDiffMetadata } from "@pierre/diffs/react";
import { isSupportedLocalImagePath } from "@synara/shared/localPreviewFiles";
import { type MouseEvent as ReactMouseEvent, useEffect, useId, useMemo, useRef } from "react";
import { ChevronDownIcon, CopyIcon, EllipsisIcon, MessageCircleIcon } from "~/lib/icons";

import { buildFileDiffRenderKey, resolveFileDiffPath } from "~/lib/diffRendering";
import {
  buildDiffFindText,
  diffFindRenderedLineForOffset,
  type DiffFindText,
} from "~/lib/find/diffFindText";
import {
  createVirtualTextFindSurface,
  type VirtualFindEntry,
} from "~/lib/find/virtualTextFindSurface";
import { isFindSurfaceVisible } from "~/lib/find/findVisibility";
import { FileDiffCard, FileDiffSurface } from "./chat/FileDiffView";
import { LocalImagePreview } from "./LocalImagePreview";
import { PanelStateMessage } from "./chat/PanelStateMessage";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { useOptionalFind } from "./find/FindProvider";
import { IconButton } from "./ui/icon-button";
import { Menu, MenuItem, MenuTrigger } from "./ui/menu";

type DiffRenderMode = "stacked" | "split";

interface DiffVirtualFindEntry extends VirtualFindEntry {
  readonly model: DiffFindText;
  readonly fileLineCount: number;
}

function occurrenceOffset(text: string, query: string, occurrence: number): number {
  const haystack = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  let offset = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    offset = haystack.indexOf(needle, index === 0 ? 0 : offset + needle.length);
    if (offset < 0) return -1;
  }
  return offset;
}

function shadowElements(root: Element, selector: string): HTMLElement[] {
  const matches: HTMLElement[] = [];
  const visit = (container: Element | ShadowRoot) => {
    for (const element of container.querySelectorAll<HTMLElement>(selector)) {
      matches.push(element);
    }
    for (const element of container.querySelectorAll<HTMLElement>("*")) {
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(root);
  return matches;
}

function highlightTextOccurrence(
  element: HTMLElement,
  query: string,
  occurrence: number,
  highlightName: string,
): boolean {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let text = "";
  let node: Node | null;
  while ((node = walker.nextNode())) {
    nodes.push(node as Text);
    text += node.textContent ?? "";
  }
  const start = occurrenceOffset(text, query, occurrence);
  if (start < 0) return false;
  const end = start + query.length;
  let consumed = 0;
  let startNode: Text | null = null;
  let endNode: Text | null = null;
  let startOffset = 0;
  let endOffset = 0;
  for (const textNode of nodes) {
    const next = consumed + textNode.data.length;
    if (!startNode && start >= consumed && start < next) {
      startNode = textNode;
      startOffset = start - consumed;
    }
    if (end > consumed && end <= next) {
      endNode = textNode;
      endOffset = end - consumed;
      break;
    }
    consumed = next;
  }
  if (!startNode || !endNode || !CSS.highlights || !globalThis.Highlight) return false;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  CSS.highlights.set(highlightName, new Highlight(range));
  element.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
  return true;
}

export interface DiffFileChatActions {
  onReferenceInChat: (filePath: string) => void;
  onAskWhyChanged: (filePath: string) => void;
}

const DIFF_FILE_ACTIONS_MENU_ICON_CLASS_NAME = "size-3.5 shrink-0 text-muted-foreground";

// Per-file actions menu rendered in the custom header's trailing slot, left of
// the collapse chevron. Marked with data-diff-header-menu so header clicks on
// it do not toggle the file collapse state.
function DiffFileHeaderActionsMenu(props: { filePath: string; chatActions: DiffFileChatActions }) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <IconButton
            variant="ghost"
            size="icon-xs"
            label="File actions"
            title="File actions"
            className="text-muted-foreground hover:text-foreground"
          >
            <EllipsisIcon className="size-3.5" />
          </IconButton>
        }
      />
      <ComposerPickerMenuPopup align="end" side="bottom" sideOffset={6} className="w-60 min-w-60">
        <MenuItem
          onClick={() => {
            props.chatActions.onReferenceInChat(props.filePath);
          }}
        >
          <MessageCircleIcon className={DIFF_FILE_ACTIONS_MENU_ICON_CLASS_NAME} />
          <span>Reference in chat</span>
        </MenuItem>
        <MenuItem
          onClick={() => {
            props.chatActions.onAskWhyChanged(props.filePath);
          }}
        >
          <MessageCircleIcon className={DIFF_FILE_ACTIONS_MENU_ICON_CLASS_NAME} />
          <span>Ask why this changed</span>
        </MenuItem>
        <MenuItem
          onClick={() => {
            void navigator.clipboard?.writeText(props.filePath);
          }}
        >
          <CopyIcon className={DIFF_FILE_ACTIONS_MENU_ICON_CLASS_NAME} />
          <span>Copy path</span>
        </MenuItem>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

function DiffFileCollapseChevron(props: { collapsed: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px",
        color: "inherit",
      }}
    >
      <ChevronDownIcon
        style={{
          width: "14px",
          height: "14px",
          transition: "transform 150ms ease",
          transform: props.collapsed ? "rotate(-90deg)" : "rotate(0deg)",
          opacity: 0.5,
        }}
      />
    </span>
  );
}

const DiffPanelFileRow = function DiffPanelFileRow(props: {
  fileDiff: FileDiffMetadata;
  resolvedTheme: "light" | "dark";
  diffRenderMode: DiffRenderMode;
  diffWordWrap: boolean;
  workspaceRoot: string | null;
  isCollapsed: boolean;
  collapsible: boolean;
  onToggleFileCollapsed: (fileKey: string) => void;
  chatActions?: DiffFileChatActions | undefined;
}) {
  const filePath = resolveFileDiffPath(props.fileDiff);
  const fileKey = buildFileDiffRenderKey(props.fileDiff);
  const { chatActions, isCollapsed } = props;
  const shouldPreviewImage =
    !isCollapsed && props.workspaceRoot !== null && isSupportedLocalImagePath(filePath);
  const renderHeaderTrailing = () => (
    <>
      {chatActions ? (
        <span data-diff-header-menu="true" className="inline-flex">
          <DiffFileHeaderActionsMenu filePath={filePath} chatActions={chatActions} />
        </span>
      ) : null}
      {props.collapsible ? <DiffFileCollapseChevron collapsed={isCollapsed} /> : null}
    </>
  );
  const handleClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!props.collapsible) return;
    const nativeEvent = event.nativeEvent;
    const composedPath = nativeEvent.composedPath?.() ?? [];
    // Clicks on the per-file actions menu must not toggle collapse.
    const clickedHeaderMenu = composedPath.some(
      (node: EventTarget) => node instanceof Element && node.hasAttribute("data-diff-header-menu"),
    );
    if (clickedHeaderMenu) return;
    const clickedHeader = composedPath.some((node: EventTarget) => {
      if (!(node instanceof Element)) return false;
      return (
        node.hasAttribute("data-diff-file-header") ||
        node.hasAttribute("data-diffs-header") ||
        node.hasAttribute("data-file-info")
      );
    });
    if (!clickedHeader) return;
    event.stopPropagation();
    props.onToggleFileCollapsed(fileKey);
  };

  return (
    <div
      data-diff-file-path={filePath}
      data-find-diff-entry-id={fileKey}
      className="diff-render-file mb-2 rounded-md first:mt-2 last:mb-0"
      onClickCapture={handleClickCapture}
    >
      <FileDiffCard
        fileDiff={props.fileDiff}
        theme={props.resolvedTheme}
        diffStyle={props.diffRenderMode === "split" ? "split" : "unified"}
        overflow={props.diffWordWrap ? "wrap" : "scroll"}
        collapsed={props.isCollapsed}
        renderHeaderTrailing={renderHeaderTrailing}
      />
      {shouldPreviewImage ? (
        <LocalImagePreview
          src={filePath}
          cwd={props.workspaceRoot}
          alt={`Preview of ${filePath}`}
          className="diff-render-file__image-preview"
          imageClassName="max-h-[320px]"
        />
      ) : null}
    </div>
  );
};

export const DiffPanelFileList = function DiffPanelFileList(props: {
  renderableFiles: ReadonlyArray<FileDiffMetadata>;
  resolvedTheme: "light" | "dark";
  diffRenderMode: DiffRenderMode;
  diffWordWrap: boolean;
  workspaceRoot: string | null;
  collapsedFiles: ReadonlySet<string>;
  onToggleFileCollapsed: (fileKey: string) => void;
  chatActions?: DiffFileChatActions | undefined;
  collapsible?: boolean | undefined;
}) {
  const registerFindSurface = useOptionalFind()?.register;
  const findSurfaceId = useId();
  const findRootRef = useRef<HTMLDivElement | null>(null);
  const findEntries = useMemo<readonly DiffVirtualFindEntry[]>(
    () =>
      props.renderableFiles.map((fileDiff, index) => {
        const id = buildFileDiffRenderKey(fileDiff);
        const model = buildDiffFindText(fileDiff, {
          collapsed: props.collapsedFiles.has(id),
          mode: props.diffRenderMode,
        });
        return {
          id,
          index,
          text: model.text,
          model,
          fileLineCount:
            props.diffRenderMode === "split" ? fileDiff.splitLineCount : fileDiff.unifiedLineCount,
        };
      }),
    [props.collapsedFiles, props.diffRenderMode, props.renderableFiles],
  );
  const findEntriesRef = useRef(findEntries);
  findEntriesRef.current = findEntries;
  useEffect(() => {
    const root = findRootRef.current;
    const scrollSurface = root?.querySelector<HTMLElement>(".diff-render-surface");
    if (!root || !scrollSurface || !registerFindSurface) return;
    const highlightName = "penkra-find-diff-active";
    return registerFindSurface(
      createVirtualTextFindSurface({
        id: `diff:${findSurfaceId}`,
        order: 20,
        isVisible: () => isFindSurfaceVisible(scrollSurface),
        getEntries: () => findEntriesRef.current,
        reveal: async (rawEntry, query, occurrence) => {
          const entry = rawEntry as DiffVirtualFindEntry;
          const wrapper = root.querySelector<HTMLElement>(
            `[data-find-diff-entry-id="${CSS.escape(entry.id)}"]`,
          );
          if (!wrapper) return;
          const offset = occurrenceOffset(entry.text, query, occurrence);
          const renderedLineIndex =
            offset < 0 ? null : diffFindRenderedLineForOffset(entry.model, offset);
          if (renderedLineIndex === null) {
            wrapper.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
          } else {
            const lineRatio =
              entry.fileLineCount > 1
                ? Math.min(1, renderedLineIndex / (entry.fileLineCount - 1))
                : 0;
            scrollSurface.scrollTo({
              top:
                wrapper.offsetTop +
                lineRatio * wrapper.offsetHeight -
                scrollSurface.clientHeight / 2,
              behavior: "instant",
            });
          }
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        },
        highlight: (rawEntry, query, occurrence) => {
          const entry = rawEntry as DiffVirtualFindEntry;
          const wrapper = root.querySelector<HTMLElement>(
            `[data-find-diff-entry-id="${CSS.escape(entry.id)}"]`,
          );
          if (!wrapper) return;
          const offset = occurrenceOffset(entry.text, query, occurrence);
          if (offset < 0) return;
          const renderedLineIndex = diffFindRenderedLineForOffset(entry.model, offset);
          const lineStartIndex = entry.model.lines.findIndex(
            (line) => line.renderedLineIndex === renderedLineIndex,
          );
          const lineStart = lineStartIndex >= 0 ? entry.model.lineStartOffsets[lineStartIndex]! : 0;
          const localOffset = offset - lineStart;
          const lineText = lineStartIndex >= 0 ? entry.model.lines[lineStartIndex]!.text : "";
          const splitAt = lineText.indexOf("\t");
          const sideIndex = splitAt >= 0 && localOffset > splitAt ? 1 : 0;
          const selector =
            renderedLineIndex === null
              ? "[data-diffs-header], [data-diff-file-header]"
              : `[data-line][data-line-index="${renderedLineIndex}"]`;
          const candidates = shadowElements(wrapper, selector).filter((element) =>
            element.textContent?.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
          );
          const candidate = candidates[Math.min(sideIndex, candidates.length - 1)];
          if (!candidate) return;
          const localOccurrence = Math.max(
            0,
            lineText
              .slice(sideIndex === 1 && splitAt >= 0 ? splitAt + 1 : 0, localOffset)
              .toLocaleLowerCase()
              .split(query.toLocaleLowerCase()).length - 1,
          );
          highlightTextOccurrence(candidate, query, localOccurrence, highlightName);
        },
        clearHighlight: () => CSS.highlights?.delete(highlightName),
      }),
    );
  }, [findEntries, findSurfaceId, registerFindSurface]);

  if (props.renderableFiles.length === 0) {
    return (
      <div ref={findRootRef} className="contents" data-find-model-owned>
        <FileDiffSurface className="h-full min-h-0 overflow-auto px-2 pb-2">
          <PanelStateMessage density="compact" fill="flex">
            <p>No files in this diff.</p>
          </PanelStateMessage>
        </FileDiffSurface>
      </div>
    );
  }

  return (
    <div ref={findRootRef} className="contents" data-find-model-owned>
      <FileDiffSurface className="h-full min-h-0 overflow-auto px-2 pb-2">
        {props.renderableFiles.map((fileDiff) => {
          const fileKey = buildFileDiffRenderKey(fileDiff);
          const themedFileKey = `${fileKey}:${props.resolvedTheme}`;
          return (
            <DiffPanelFileRow
              key={themedFileKey}
              fileDiff={fileDiff}
              resolvedTheme={props.resolvedTheme}
              diffRenderMode={props.diffRenderMode}
              diffWordWrap={props.diffWordWrap}
              workspaceRoot={props.workspaceRoot}
              isCollapsed={props.collapsedFiles.has(fileKey)}
              collapsible={props.collapsible ?? true}
              onToggleFileCollapsed={props.onToggleFileCollapsed}
              chatActions={props.chatActions}
            />
          );
        })}
      </FileDiffSurface>
    </div>
  );
};
