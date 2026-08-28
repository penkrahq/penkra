// FILE: ChatMarkdown.tsx
// Purpose: Renders assistant and plan markdown with syntax highlighting and local file links.
// Layer: Web chat presentation component
// Exports: ChatMarkdown

import { CheckIcon, CopyIcon, TextWrapIcon } from "~/lib/icons";
import type { ProviderMentionReference } from "@penkra/contracts";
import "katex/dist/katex.min.css";
import React, {
  Children,
  type CSSProperties,
  Suspense,
  isValidElement,
  memo,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { defaultUrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { copyTextToClipboard } from "../hooks/useCopyToClipboard";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { dedentCode, parseCodeFenceInfo, type CodeFenceInfo } from "../lib/codeFence";
import { getFileIconName } from "../file-icons";
import { CentralIcon } from "~/lib/central-icons";
import { isLocalImageMarkdownSrc } from "../lib/localImageUrls";
import { useTheme } from "../hooks/useTheme";
import { openThreadFileReference, useThreadResourceOpener } from "../lib/threadResourceOpener";
import { resolveMarkdownFileLinkTarget, rewriteMarkdownFileUriHref } from "../markdown-links";
import type { ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { GeneratedMarkdownImage } from "./chat/GeneratedMarkdownImage";
import { TerminalContextInlineChip } from "./chat/TerminalContextInlineChip";
import type { ParsedTerminalContextEntry } from "../lib/terminalContext";
import { formatInlineTerminalContextLabel } from "./chat/userMessageTerminalContexts";
import {
  COMPOSER_INLINE_CHIP_ICON_LABEL_GAP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_TOKEN_ICON_CLASS_NAME,
} from "./composerInlineChip";
import { LinkChipIcon } from "./LinkChipIcon";
import { InlineAgentChip } from "./chat/InlineAgentChip";
import { InlineLinkChip } from "./InlineLinkChip";
import { InlineMentionChip } from "./chat/InlineMentionChip";
import { InlineSkillChip } from "./chat/InlineSkillChip";
import {
  COMPOSER_CHIP_SEGMENT_ATTRIBUTE,
  COMPOSER_CHIP_TAG_NAME,
  TERMINAL_CONTEXT_CHIP_INDEX_ATTRIBUTE,
  TERMINAL_CONTEXT_CHIP_TAG_NAME,
  createComposerChipsRemarkPlugin,
  parseComposerChipSegment,
} from "../lib/remarkComposerChips";
import { IconButton } from "./ui/icon-button";

const EXTERNAL_HTTP_HREF_PATTERN = /^https?:\/\//i;
// Trailing `:line` / `:line:col` position suffix on a resolved file link. Kept on
// the href (so opening jumps to the line) but stripped for icon/title resolution.
const MARKDOWN_LINK_POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const MARKDOWN_EXTERNAL_LINK_CLASS_NAME =
  "inline font-medium text-[var(--info-foreground)] underline-offset-2 hover:underline";
const MARKDOWN_EXTERNAL_LINK_ICON_CLASS_NAME = `${COMPOSER_INLINE_CHIP_TOKEN_ICON_CLASS_NAME} ${COMPOSER_INLINE_CHIP_ICON_LABEL_GAP_CLASS_NAME}`;

function isExternalHttpHref(href: string | undefined): href is string {
  return typeof href === "string" && EXTERNAL_HTTP_HREF_PATTERN.test(href);
}

class CodeHighlightErrorBoundary extends React.Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  isStreaming?: boolean;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  /**
   * "user" renders a sent prompt: GFM plus hard line breaks (single newlines
   * survive the way they were typed), no math/KaTeX and no literal-dollar
   * rewriting (`$50` and `$skill` stay verbatim), and composer inline tokens
   * (skills, mentions, agents, bare links) render as the shared chips.
   */
  variant?: "assistant" | "user";
  /** Mention metadata for chip icon resolution; only used by the user variant. */
  mentionReferences?: ReadonlyArray<ProviderMentionReference> | undefined;
  /** Terminal selections rendered as inline chips inside user-message markdown. */
  terminalContexts?: ReadonlyArray<ParsedTerminalContextEntry> | undefined;
  /**
   * Makes GFM task-list checkboxes interactive. Receives the 1-based line of
   * the task item in `text` so the caller can flip that `[ ]` marker at the
   * source (line numbers stay valid because the internal dollar protection is
   * length- and newline-preserving). Without it checkboxes render read-only.
   */
  onTaskToggle?: ((input: { sourceLine: number; checked: boolean }) => void) | undefined;
}

// Source line of the enclosing task-list item, provided by the `li` override.
// The checkbox `input` element is synthesized by mdast-util-to-hast without
// position info, so it cannot read its own source location.
const TaskItemSourceLineContext = React.createContext<number | null>(null);

function MarkdownTaskCheckbox(props: {
  checked: boolean;
  onTaskToggle: ChatMarkdownProps["onTaskToggle"];
}) {
  const { checked, onTaskToggle } = props;
  const sourceLine = React.useContext(TaskItemSourceLineContext);
  const interactive = onTaskToggle !== undefined && sourceLine !== null;
  return (
    <input
      type="checkbox"
      className="chat-markdown-task-checkbox"
      checked={checked}
      disabled={!interactive}
      {...(interactive ? { onChange: () => onTaskToggle({ sourceLine, checked: !checked }) } : {})}
    />
  );
}

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
type MarkdownRemarkPlugins = NonNullable<
  React.ComponentProps<typeof ReactMarkdown>["remarkPlugins"]
>;
type MarkdownRehypePlugins = NonNullable<
  React.ComponentProps<typeof ReactMarkdown>["rehypePlugins"]
>;
const MARKDOWN_REMARK_PLUGINS: MarkdownRemarkPlugins = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: true }],
];
// User prompts are casual typing, not authored markdown: hard-break single
// newlines and skip math entirely (the composer chip plugin is appended per
// render because it closes over the message's mention references).
const USER_MARKDOWN_REMARK_PLUGINS: MarkdownRemarkPlugins = [remarkGfm, remarkBreaks];
const USER_MARKDOWN_REHYPE_PLUGINS: MarkdownRehypePlugins = [];
const LITERAL_DOLLAR_PLACEHOLDER = "\uE000";
// `\$` is two source characters that render as a single `$`. Keep a two-character placeholder so
// the protection pass remains length-preserving; restore it ahead of the single-char placeholder.
const ESCAPED_DOLLAR_PLACEHOLDER = "\uE001\uE002";

function restoreLiteralDollarPlaceholders(value: string): string {
  return value
    .replaceAll(ESCAPED_DOLLAR_PLACEHOLDER, "$")
    .replaceAll(LITERAL_DOLLAR_PLACEHOLDER, "$")
    .replaceAll(encodeURIComponent(ESCAPED_DOLLAR_PLACEHOLDER), "$")
    .replaceAll(encodeURIComponent(LITERAL_DOLLAR_PLACEHOLDER), "$");
}

function markdownUrlTransform(href: string): string {
  const restoredHref = restoreLiteralDollarPlaceholders(href);
  return rewriteMarkdownFileUriHref(restoredHref) ?? defaultUrlTransform(restoredHref);
}

function restoreLiteralDollarsInNode(node: unknown): void {
  if (!node || typeof node !== "object") {
    return;
  }

  if ("type" in node && node.type === "text" && "value" in node && typeof node.value === "string") {
    node.value = restoreLiteralDollarPlaceholders(node.value);
  }

  if ("children" in node && Array.isArray(node.children)) {
    for (const child of node.children) {
      restoreLiteralDollarsInNode(child);
    }
  }
}

function rehypeRestoreLiteralDollars() {
  return (tree: unknown) => {
    restoreLiteralDollarsInNode(tree);
  };
}

const MARKDOWN_REHYPE_PLUGINS: MarkdownRehypePlugins = [
  [rehypeKatex, { output: "htmlAndMathml", strict: false, throwOnError: false }],
  rehypeRestoreLiteralDollars,
];
const INLINE_MATH_HINT_REGEX = /[\\^_=+\-*/<>()[\]{}]/;
const ALL_CAPS_DOLLAR_IDENTIFIER_REGEX = /^[A-Z][A-Z0-9_]{1,31}$/;

function isLineStart(value: string, index: number): boolean {
  return index === 0 || value[index - 1] === "\n";
}

function matchFenceDelimiter(
  value: string,
  index: number,
): { marker: "`" | "~"; length: number } | null {
  if (!isLineStart(value, index)) {
    return null;
  }

  const marker = value[index];
  if (marker !== "`" && marker !== "~") {
    return null;
  }

  let cursor = index;
  while (value[cursor] === marker) {
    cursor += 1;
  }

  return cursor - index >= 3 ? { marker, length: cursor - index } : null;
}

function findFenceEndIndex(
  value: string,
  index: number,
  marker: "`" | "~",
  length: number,
): number {
  let cursor = value.indexOf("\n", index);
  if (cursor === -1) {
    return value.length;
  }
  cursor += 1;

  while (cursor < value.length) {
    if (isLineStart(value, cursor) && value[cursor] === marker) {
      let markerEnd = cursor;
      while (value[markerEnd] === marker) {
        markerEnd += 1;
      }
      if (markerEnd - cursor >= length) {
        const lineEnd = value.indexOf("\n", markerEnd);
        return lineEnd === -1 ? value.length : lineEnd + 1;
      }
    }

    const nextLine = value.indexOf("\n", cursor);
    if (nextLine === -1) {
      return value.length;
    }
    cursor = nextLine + 1;
  }

  return value.length;
}

function findInlineCodeEndIndex(value: string, index: number, length: number): number {
  let cursor = index + length;
  while (cursor < value.length) {
    if (value[cursor] !== "`") {
      cursor += 1;
      continue;
    }

    let markerEnd = cursor;
    while (value[markerEnd] === "`") {
      markerEnd += 1;
    }

    if (markerEnd - cursor === length) {
      return markerEnd;
    }
    cursor = markerEnd;
  }

  return value.length;
}

function looksLikeInlineMath(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (ALL_CAPS_DOLLAR_IDENTIFIER_REGEX.test(trimmed)) {
    return false;
  }
  if (INLINE_MATH_HINT_REGEX.test(trimmed)) {
    return true;
  }
  return /^[A-Za-z][A-Za-z0-9]{0,15}$/.test(trimmed);
}

// Reject obvious literal/currency dollars before searching for a closing math delimiter.
function canOpenInlineMath(value: string, index: number): boolean {
  const next = value[index + 1];
  if (!next || /\s|\d/.test(next)) {
    return false;
  }
  return true;
}

// Markdown math delimiters should hug content; loose "$ " endings are treated as prose.
function canCloseInlineMath(value: string, index: number): boolean {
  const previous = value[index - 1];
  if (!previous || /\s/.test(previous)) {
    return false;
  }
  return true;
}

function findInlineMathClosingDollar(value: string, index: number): number {
  let cursor = index;
  while (cursor < value.length) {
    if (value[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (value[cursor] === "$") {
      return canCloseInlineMath(value, cursor) ? cursor : -1;
    }
    cursor += 1;
  }
  return -1;
}

function protectLiteralDollarsInPlainText(value: string): string {
  let result = "";
  let cursor = 0;

  while (cursor < value.length) {
    if (value[cursor] === "\\" && value[cursor + 1] === "$") {
      result += ESCAPED_DOLLAR_PLACEHOLDER;
      cursor += 2;
      continue;
    }

    if (value.startsWith("$$", cursor)) {
      const closingIndex = value.indexOf("$$", cursor + 2);
      if (closingIndex === -1) {
        result += `${LITERAL_DOLLAR_PLACEHOLDER}${LITERAL_DOLLAR_PLACEHOLDER}`;
        cursor += 2;
        continue;
      }
      result += value.slice(cursor, closingIndex + 2);
      cursor = closingIndex + 2;
      continue;
    }

    if (value[cursor] === "$") {
      if (!canOpenInlineMath(value, cursor)) {
        result += LITERAL_DOLLAR_PLACEHOLDER;
        cursor += 1;
        continue;
      }

      const closingIndex = findInlineMathClosingDollar(value, cursor + 1);
      if (closingIndex === -1) {
        result += LITERAL_DOLLAR_PLACEHOLDER;
        cursor += 1;
        continue;
      }

      const content = value.slice(cursor + 1, closingIndex);
      result += looksLikeInlineMath(content)
        ? `$${content}$`
        : `${LITERAL_DOLLAR_PLACEHOLDER}${content}${LITERAL_DOLLAR_PLACEHOLDER}`;
      cursor = closingIndex + 1;
      continue;
    }

    result += value[cursor];
    cursor += 1;
  }

  return result;
}

function findMarkdownBracketEnd(value: string, startIndex: number): number {
  let depth = 0;
  let cursor = startIndex;

  while (cursor < value.length) {
    if (value[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (value[cursor] === "[") {
      depth += 1;
    } else if (value[cursor] === "]") {
      depth -= 1;
      if (depth === 0) {
        return cursor;
      }
    }
    cursor += 1;
  }

  return -1;
}

function findMarkdownParenEnd(value: string, startIndex: number): number {
  let depth = 0;
  let cursor = startIndex;

  while (cursor < value.length) {
    if (value[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (value[cursor] === "(") {
      depth += 1;
    } else if (value[cursor] === ")") {
      depth -= 1;
      if (depth === 0) {
        return cursor;
      }
    }
    cursor += 1;
  }

  return -1;
}

function findInlineMarkdownLinkEnd(value: string, index: number): number {
  const bracketStart = value[index] === "!" && value[index + 1] === "[" ? index + 1 : index;
  if (value[bracketStart] !== "[") {
    return -1;
  }

  const bracketEnd = findMarkdownBracketEnd(value, bracketStart);
  if (bracketEnd === -1 || value[bracketEnd + 1] !== "(") {
    return -1;
  }

  const parenEnd = findMarkdownParenEnd(value, bracketEnd + 1);
  return parenEnd === -1 ? -1 : parenEnd + 1;
}

function protectLiteralDollarsInMarkdownLinks(value: string): string {
  let result = "";
  let cursor = 0;

  while (cursor < value.length) {
    const isLinkStart =
      value[cursor] === "[" || (value[cursor] === "!" && value[cursor + 1] === "[");
    if (!isLinkStart) {
      const nextLinkStart = value.indexOf("[", cursor);
      const nextImageStart = value.indexOf("![", cursor);
      const candidates = [nextLinkStart, nextImageStart].filter((candidate) => candidate >= 0);
      const nextIndex = candidates.length > 0 ? Math.min(...candidates) : value.length;
      result += protectLiteralDollarsInPlainText(value.slice(cursor, nextIndex));
      cursor = nextIndex;
      continue;
    }

    const linkEnd = findInlineMarkdownLinkEnd(value, cursor);
    if (linkEnd === -1) {
      result += protectLiteralDollarsInPlainText(value[cursor] ?? "");
      cursor += 1;
      continue;
    }

    // Inline links are parsed after math, so protect route params like `_chat.$threadId.tsx`.
    result += value.slice(cursor, linkEnd).replaceAll("$", LITERAL_DOLLAR_PLACEHOLDER);
    cursor = linkEnd;
  }

  return result;
}

// Tighten single-dollar math so currency and escaped dollars stay literal without touching code spans.
function protectLiteralMarkdownDollars(value: string): string {
  let result = "";
  let cursor = 0;

  while (cursor < value.length) {
    const fenceDelimiter = matchFenceDelimiter(value, cursor);
    if (fenceDelimiter) {
      const fenceEndIndex = findFenceEndIndex(
        value,
        cursor,
        fenceDelimiter.marker,
        fenceDelimiter.length,
      );
      result += value.slice(cursor, fenceEndIndex);
      cursor = fenceEndIndex;
      continue;
    }

    if (value[cursor] === "`") {
      let markerEnd = cursor;
      while (value[markerEnd] === "`") {
        markerEnd += 1;
      }
      const inlineCodeEndIndex = findInlineCodeEndIndex(value, cursor, markerEnd - cursor);
      result += value.slice(cursor, inlineCodeEndIndex);
      cursor = inlineCodeEndIndex;
      continue;
    }

    let nextCodeIndex = cursor;
    while (nextCodeIndex < value.length) {
      if (value[nextCodeIndex] === "`" || matchFenceDelimiter(value, nextCodeIndex)) {
        break;
      }
      nextCodeIndex += 1;
    }

    result += protectLiteralDollarsInMarkdownLinks(value.slice(cursor, nextCodeIndex));
    cursor = nextCodeIndex;
  }

  return result;
}

// Returns the raw fence info string (the token after ```), e.g. "ts" or the
// Cursor reference form "173:186:packages/shared/src/model.ts". Parsing into a
// highlighter language + file metadata is handled by `parseCodeFenceInfo`.
function extractRawFenceInfo(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  return match?.[1] ?? "text";
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }

  // The single child is the fenced code element. Its rendered `type` is the
  // custom `code` component (not the string "code") once we override `code`
  // below, so detect by shape (a valid element carrying the code text) rather
  // than by tag identity. `pre` only ever wraps a code element in markdown.
  const onlyChild = childNodes[0];
  if (!isValidElement<{ className?: string; children?: ReactNode }>(onlyChild)) {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

// Shared openable file chip: the same mention-chip UI (file icon + medium label)
// used for authored assistant markdown file links. Inline code remains literal;
// only an explicit link or composer mention carries file-reference intent.
// File chips delegate to the Thread's configured resource handler. `targetPath`
// may carry a `:line` suffix; the chip icon and title use the position-free path.
function OpenableFileChip(props: {
  targetPath: string;
  theme: "light" | "dark";
  label?: ReactNode;
  href?: string;
}) {
  const opener = useThreadResourceOpener();
  const chipPath = props.targetPath.replace(MARKDOWN_LINK_POSITION_SUFFIX_PATTERN, "");
  return (
    <InlineMentionChip
      path={chipPath}
      theme={props.theme}
      href={props.href ?? props.targetPath}
      onActivate={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openThreadFileReference(opener, props.targetPath);
      }}
      {...(props.label !== undefined ? { label: props.label } : {})}
    />
  );
}

// Renders the custom element emitted by the composer-chips remark plugin with the
// shared chip components, so chips in a sent message match the composer exactly.
function ComposerChipElement(props: {
  serializedSegment: string | undefined;
  theme: "light" | "dark";
  mentionReferences: ReadonlyArray<ProviderMentionReference>;
}) {
  const segment = parseComposerChipSegment(props.serializedSegment);
  if (!segment) {
    return null;
  }
  if (segment.type === "skill") {
    return <InlineSkillChip skillName={segment.name} />;
  }
  if (segment.type === "mention") {
    return (
      <InlineMentionChip
        path={segment.path}
        theme={props.theme}
        mentionReferences={props.mentionReferences}
        {...(segment.kind ? { kind: segment.kind } : {})}
      />
    );
  }
  if (segment.type === "agent-mention") {
    return <InlineAgentChip alias={segment.alias} color={segment.color} />;
  }
  return <InlineLinkChip url={segment.url} interactive />;
}

function CodeBlockHeaderTitle({ fence }: { fence: CodeFenceInfo }) {
  if (fence.isFileReference && fence.fileName) {
    return (
      <span className="chat-markdown-codeblock__file" title={fence.filePath ?? fence.fileName}>
        <CentralIcon
          name={getFileIconName(fence.filePath ?? fence.fileName)}
          className="chat-markdown-codeblock__file-icon"
        />
        <span className="chat-markdown-codeblock__file-name">{fence.fileName}</span>
        {fence.directory ? (
          <span className="chat-markdown-codeblock__file-dir">{fence.directory}</span>
        ) : null}
        {fence.lineRange ? (
          <span className="chat-markdown-codeblock__file-lines">{fence.lineRange}</span>
        ) : null}
      </span>
    );
  }

  return <span className="chat-markdown-codeblock__lang">{fence.language}</span>;
}

function MarkdownCodeBlock({
  code,
  fence,
  children,
}: {
  code: string;
  fence: CodeFenceInfo;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = () => {
    void copyTextToClipboard(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch(() => undefined);
  };
  const toggleWrap = () => setWrap((previous) => !previous);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div className="chat-markdown-codeblock" data-wrap={wrap ? "true" : "false"}>
      <div className="chat-markdown-codeblock__header">
        <CodeBlockHeaderTitle fence={fence} />
        <div className="chat-markdown-codeblock__actions">
          <IconButton
            className="chat-markdown-codeblock__action"
            onClick={toggleWrap}
            title={wrap ? "Disable soft wrap" : "Enable soft wrap"}
            label={wrap ? "Disable soft wrap" : "Enable soft wrap"}
            aria-pressed={wrap}
            data-active={wrap ? "true" : "false"}
            size="icon-xs"
            variant="ghost"
          >
            <TextWrapIcon className="size-3" />
          </IconButton>
          <IconButton
            className="chat-markdown-codeblock__action"
            onClick={handleCopy}
            title={copied ? "Copied" : "Copy code"}
            label={copied ? "Copied" : "Copy code"}
            size="icon-xs"
            variant="ghost"
          >
            {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          </IconButton>
        </div>
      </div>
      <div className="chat-markdown-codeblock__body">{children}</div>
    </div>
  );
}

interface SuspenseShikiCodeBlockProps {
  language: string;
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
}

type SyntaxHighlightingModule = typeof import("../lib/syntaxHighlighting");
let syntaxHighlightingModulePromise: Promise<SyntaxHighlightingModule> | null = null;

function getSyntaxHighlightingModulePromise(): Promise<SyntaxHighlightingModule> {
  syntaxHighlightingModulePromise ??= import("../lib/syntaxHighlighting");
  return syntaxHighlightingModulePromise;
}

function SuspenseShikiCodeBlock({
  language,
  code,
  themeName,
  isStreaming,
}: SuspenseShikiCodeBlockProps) {
  const syntaxHighlighting = use(getSyntaxHighlightingModulePromise());
  return (
    <LoadedShikiCodeBlock
      syntaxHighlighting={syntaxHighlighting}
      language={language}
      code={code}
      themeName={themeName}
      isStreaming={isStreaming}
    />
  );
}

function LoadedShikiCodeBlock({
  syntaxHighlighting,
  language,
  code,
  themeName,
  isStreaming,
}: SuspenseShikiCodeBlockProps & { syntaxHighlighting: SyntaxHighlightingModule }) {
  const cacheKey = syntaxHighlighting.createSyntaxHighlightCacheKey(code, language, themeName);
  const cachedHighlightedHtml = !isStreaming
    ? syntaxHighlighting.getCachedSyntaxHighlightedHtml(cacheKey)
    : null;

  if (cachedHighlightedHtml != null) {
    return (
      <div
        className="chat-markdown-shiki"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
    );
  }

  // The uncached path lives in its own component: an early return above must
  // not change this component's hook order once the cache fills.
  return (
    <UncachedShikiCodeBlock
      syntaxHighlighting={syntaxHighlighting}
      cacheKey={cacheKey}
      language={language}
      code={code}
      themeName={themeName}
      isStreaming={isStreaming}
    />
  );
}

function UncachedShikiCodeBlock({
  syntaxHighlighting,
  cacheKey,
  language,
  code,
  themeName,
  isStreaming,
}: SuspenseShikiCodeBlockProps & {
  syntaxHighlighting: SyntaxHighlightingModule;
  cacheKey: string;
}) {
  const highlighter = use(syntaxHighlighting.getSyntaxHighlighterPromise(language));
  const highlightedHtml = syntaxHighlighting.highlightCodeToHtmlWithFallback(
    highlighter,
    code,
    language,
    themeName,
  );

  useEffect(() => {
    if (!isStreaming) {
      syntaxHighlighting.cacheSyntaxHighlightedHtml(cacheKey, highlightedHtml, code);
    }
  }, [cacheKey, code, highlightedHtml, isStreaming, syntaxHighlighting]);

  return (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
  );
}

function ChatMarkdown({
  text,
  cwd,
  isStreaming: isStreamingProp,
  className: classNameProp,
  style,
  onImageExpand,
  onTaskToggle,
  variant: variantProp,
  mentionReferences,
  terminalContexts,
}: ChatMarkdownProps) {
  // Defaults applied with ?? in the body, not in the destructuring: default
  // values in parameter destructuring make React Compiler 1.0.0 bail on the
  // whole component (BuildHIR AssignmentPattern), losing its auto-memoization.
  const isStreaming = isStreamingProp ?? false;
  const className =
    classNameProp ?? "text-[length:calc(var(--app-font-size-base,12px)*1.1667)] leading-relaxed";
  const variant = variantProp ?? "assistant";
  const { resolvedTheme } = useTheme();
  const resourceOpener = useThreadResourceOpener();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const isUserVariant = variant === "user";
  // The dollar rewrite exists to disambiguate math from currency; the user
  // variant has no math, so its text must stay byte-for-byte what was typed.
  const normalizedText = useMemo(
    () => (isUserVariant ? text : protectLiteralMarkdownDollars(text)),
    [isUserVariant, text],
  );
  const composerChipsRemarkPlugin = useMemo(
    () =>
      isUserVariant
        ? createComposerChipsRemarkPlugin(
            mentionReferences ?? [],
            (terminalContexts ?? []).map((context, index) => ({
              label: formatInlineTerminalContextLabel(context.header),
              index,
            })),
          )
        : null,
    [isUserVariant, mentionReferences, terminalContexts],
  );
  const remarkPlugins = useMemo<MarkdownRemarkPlugins>(() => {
    if (composerChipsRemarkPlugin) {
      return [...USER_MARKDOWN_REMARK_PLUGINS, composerChipsRemarkPlugin];
    }
    return MARKDOWN_REMARK_PLUGINS;
  }, [composerChipsRemarkPlugin]);
  const rehypePlugins = isUserVariant ? USER_MARKDOWN_REHYPE_PLUGINS : MARKDOWN_REHYPE_PLUGINS;
  const markdownComponents = useMemo<Components>(
    () => ({
      a({ node: _node, href, children, ...props }) {
        const restoredHref = href ? restoreLiteralDollarPlaceholders(href) : href;
        const isExternalHttp = isExternalHttpHref(restoredHref);
        if (isUserVariant && isExternalHttp) {
          // GFM autolinks a pasted URL before the chips plugin can see it; when the
          // link text is just the URL itself, render the composer's link chip so a
          // pasted link looks identical in the composer and in the sent bubble.
          // Authored `[label](url)` links keep the regular anchor treatment below.
          const plainText = nodeToPlainText(children);
          if (
            plainText === restoredHref ||
            restoredHref === `http://${plainText}` ||
            restoredHref === `https://${plainText}`
          ) {
            return <InlineLinkChip url={restoredHref} interactive />;
          }
        }
        const targetPath = isExternalHttp ? null : resolveMarkdownFileLinkTarget(restoredHref, cwd);
        if (!targetPath) {
          return (
            <a
              {...props}
              href={restoredHref}
              target="_blank"
              rel="noopener noreferrer"
              className={isExternalHttp ? MARKDOWN_EXTERNAL_LINK_CLASS_NAME : props.className}
              onClick={(event) => {
                if (!isExternalHttp || !restoredHref || !resourceOpener?.openUrl(restoredHref)) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              {isExternalHttp ? (
                <LinkChipIcon
                  url={restoredHref}
                  className={MARKDOWN_EXTERNAL_LINK_ICON_CLASS_NAME}
                />
              ) : null}
              {children}
            </a>
          );
        }

        // Local file links keep their openable behavior but adopt the shared
        // mention-chip UI (file icon + medium label). The link text is preserved
        // as the label.
        return (
          <OpenableFileChip
            targetPath={targetPath}
            theme={resolvedTheme}
            label={nodeToPlainText(children)}
            {...(restoredHref ? { href: restoredHref } : {})}
          />
        );
      },
      pre({ node: _node, children, ...props }) {
        const codeBlock = extractCodeBlock(children);
        if (!codeBlock) {
          return <pre {...props}>{children}</pre>;
        }

        const fence = parseCodeFenceInfo(extractRawFenceInfo(codeBlock.className));
        const code = dedentCode(codeBlock.code);

        return (
          <MarkdownCodeBlock code={code} fence={fence}>
            <CodeHighlightErrorBoundary fallback={<pre {...props}>{children}</pre>}>
              <Suspense fallback={<pre {...props}>{children}</pre>}>
                <SuspenseShikiCodeBlock
                  language={fence.language}
                  code={code}
                  themeName={diffThemeName}
                  isStreaming={isStreaming}
                />
              </Suspense>
            </CodeHighlightErrorBoundary>
          </MarkdownCodeBlock>
        );
      },
      code({ node: _node, className, children, ...props }) {
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      },
      img({ node: _node, src, alt: altProp, ...props }) {
        const alt = altProp ?? "";
        const restoredSrc = src ? restoreLiteralDollarPlaceholders(src) : "";
        if (isLocalImageMarkdownSrc(restoredSrc)) {
          return (
            <GeneratedMarkdownImage
              src={restoredSrc}
              alt={alt}
              cwd={cwd}
              onImageExpand={onImageExpand}
            />
          );
        }
        return <img {...props} src={restoredSrc} alt={alt} loading="lazy" />;
      },
      li({ node, children, ...props }) {
        // Task items carry their source line down to the checkbox via context.
        const isTaskItem =
          typeof props.className === "string" && props.className.includes("task-list-item");
        const sourceLine = node?.position?.start.line ?? null;
        if (!isTaskItem || sourceLine === null) {
          return <li {...props}>{children}</li>;
        }
        return (
          <li {...props}>
            <TaskItemSourceLineContext.Provider value={sourceLine}>
              {children}
            </TaskItemSourceLineContext.Provider>
          </li>
        );
      },
      input({ node: _node, ...props }) {
        if (props.type === "checkbox") {
          return (
            <MarkdownTaskCheckbox checked={props.checked === true} onTaskToggle={onTaskToggle} />
          );
        }
        return <input {...props} />;
      },
      // Custom elements emitted by the composer-chips remark plugin (user
      // variant only; they never appear in assistant markdown). `Components`
      // only models intrinsic tags, so these entries are typed on their own
      // and cast into the map.
      ...({
        [COMPOSER_CHIP_TAG_NAME]: (props: {
          className?: string | undefined;
          [COMPOSER_CHIP_SEGMENT_ATTRIBUTE]?: string | undefined;
        }) => (
          <ComposerChipElement
            serializedSegment={props[COMPOSER_CHIP_SEGMENT_ATTRIBUTE]}
            theme={resolvedTheme}
            mentionReferences={mentionReferences ?? []}
          />
        ),
        [TERMINAL_CONTEXT_CHIP_TAG_NAME]: (props: {
          [TERMINAL_CONTEXT_CHIP_INDEX_ATTRIBUTE]?: string | undefined;
        }) => {
          const rawIndex = props[TERMINAL_CONTEXT_CHIP_INDEX_ATTRIBUTE];
          const index = rawIndex === undefined ? Number.NaN : Number.parseInt(rawIndex, 10);
          const context = Number.isInteger(index) ? terminalContexts?.[index] : undefined;
          if (!context) {
            return null;
          }
          const tooltipText =
            context.body.length > 0 ? `${context.header}\n${context.body}` : context.header;
          return <TerminalContextInlineChip label={context.header} tooltipText={tooltipText} />;
        },
      } as unknown as Components),
    }),
    [
      cwd,
      diffThemeName,
      isStreaming,
      isUserVariant,
      mentionReferences,
      onImageExpand,
      onTaskToggle,
      resolvedTheme,
      resourceOpener,
      terminalContexts,
    ],
  );

  return (
    <div
      className={`chat-markdown ${isUserVariant ? "chat-markdown--user " : ""}w-full min-w-0 ${className} text-foreground`}
      style={style}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={markdownComponents}
        urlTransform={markdownUrlTransform}
      >
        {normalizedText}
      </ReactMarkdown>
    </div>
  );
}

export default memo(ChatMarkdown);
