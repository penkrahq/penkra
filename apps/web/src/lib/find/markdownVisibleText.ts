// FILE: markdownVisibleText.ts
// Purpose: Folders markdown source into the same textual content rendered to the transcript.
// Layer: Web application infrastructure
// Exports: markdownVisibleText

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

interface MarkdownNode {
  readonly type?: string;
  readonly value?: string;
  readonly alt?: string | null;
  readonly children?: readonly MarkdownNode[];
}

const BLOCK_CONTAINERS = new Set(["root", "blockquote", "list", "listItem", "table"]);

function visibleNodeText(node: MarkdownNode): string {
  if (typeof node.value === "string") return node.value;
  if (node.type === "image") return node.alt ?? "";
  const children = node.children ?? [];
  const separator = BLOCK_CONTAINERS.has(node.type ?? "") || node.type === "tableRow" ? "\n" : "";
  const text = children.map(visibleNodeText).filter(Boolean).join(separator);
  return node.type === "tableRow" ? text.replaceAll("\n", " ") : text;
}

export function markdownVisibleText(markdown: string): string {
  if (!markdown) return "";
  return visibleNodeText(
    fromMarkdown(markdown, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    }) as MarkdownNode,
  );
}
