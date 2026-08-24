import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@pierre/diffs", () => ({
  getFiletypeFromFileName: (fileName: string) => (fileName.endsWith(".ts") ? "ts" : "text"),
  getSharedHighlighter: () =>
    Promise.resolve({
      codeToHtml(code: string) {
        return `<pre class="shiki"><code>${code}</code></pre>`;
      },
    }),
}));

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

async function renderMarkdown(text: string, cwd = "C:\\Users\\LENOVO\\penkra") {
  const { default: ChatMarkdown } = await import("./ChatMarkdown");

  return renderToStaticMarkup(<ChatMarkdown text={text} cwd={cwd} isStreaming={false} />);
}

async function renderUserMarkdown(text: string) {
  const { default: ChatMarkdown } = await import("./ChatMarkdown");

  return renderToStaticMarkup(
    <ChatMarkdown text={text} cwd={undefined} isStreaming={false} variant="user" />,
  );
}

describe("ChatMarkdown", () => {
  it("uses the theme foreground token for markdown text", async () => {
    const markup = await renderMarkdown("Theme-aware text");

    expect(markup).toContain("text-foreground");
    expect(markup).not.toContain("text-neutral-900");
  }, 15_000);

  it("renders inline math with KaTeX", async () => {
    const markup = await renderMarkdown("Euler wrote $e^{i\\\\pi} + 1 = 0$.");

    expect(markup).toContain('class="katex"');
    expect(markup).not.toContain("katex-display");
    expect(markup).not.toContain("$e^{i\\\\pi} + 1 = 0$");
  });

  it("renders display math with KaTeX block output", async () => {
    const markup = await renderMarkdown("$$\n\\\\int_0^1 x^2 \\, dx\n$$");

    expect(markup).toContain("katex-display");
    expect(markup).not.toContain("$$");
  });

  it("keeps links and code intact when math is present", async () => {
    const markup = await renderMarkdown(
      [
        "Read [local notes](./notes.md) and [external docs](https://example.com).",
        "",
        "Inline math $x^2 + y^2$ still renders.",
        "",
        "Inline code `$z$` stays literal.",
        "",
        "```ts",
        'const price = "$5";',
        "```",
      ].join("\n"),
    );

    expect(markup).toContain('href="./notes.md"');
    expect(markup).not.toContain('href="./notes.md" target="_blank"');
    expect(markup).toContain(
      'href="https://example.com" target="_blank" rel="noopener noreferrer"',
    );
    expect(markup).toContain("<code>$z$</code>");
    expect(markup).toContain("const price = &quot;$5&quot;;");
    expect(markup.match(/class="katex"/g) ?? []).toHaveLength(1);
  });

  it("keeps filename-shaped inline code literal", async () => {
    const markup = await renderMarkdown(
      "Review `runtime-AGENTS.md`, `src/index.ts`, and `package.json`.",
      "/Users/julius/project",
    );

    expect(markup).toContain("<code>runtime-AGENTS.md</code>");
    expect(markup).toContain("<code>src/index.ts</code>");
    expect(markup).toContain("<code>package.json</code>");
    expect(markup).not.toContain('data-slot="central-icon"');
  });

  it("keeps explicit markdown file links openable", async () => {
    const markup = await renderMarkdown(
      "Review [runtime-AGENTS.md](services/sandbox/assets/runtime-AGENTS.md).",
      "/Users/julius/project",
    );

    expect(markup).toContain('href="services/sandbox/assets/runtime-AGENTS.md"');
    expect(markup).toContain(
      'title="/Users/julius/project/services/sandbox/assets/runtime-AGENTS.md"',
    );
    expect(markup).toContain('data-slot="central-icon"');
  });

  it("renders external assistant links with the shared favicon icon slot", async () => {
    const markup = await renderMarkdown(
      "Closest source: [OpenAI benchmark](https://openai.com/research).",
    );

    expect(markup).toContain(
      'class="inline font-medium text-[var(--info-foreground)] underline-offset-2 hover:underline"',
    );
    expect(markup).toContain("inline-block size-[1em] shrink-0 align-middle -translate-y-px mr-1");
    expect(markup).toContain("OpenAI benchmark");
  });

  it("keeps dollar signs in markdown file links from becoming math", async () => {
    const source =
      "Files touched:\n\n- [_chat.$threadId.tsx](/Users/julius/project/apps/web/src/routes/_chat.$threadId.tsx:1192)";
    const markup = await renderMarkdown(source, "/Users/julius/project");

    expect(markup).toContain(
      'href="/Users/julius/project/apps/web/src/routes/_chat.$threadId.tsx:1192"',
    );
    expect(markup).toContain("_chat.$threadId.tsx");
    expect(markup).not.toContain('class="katex"');
    expect(markup).not.toContain("CHATMARKDOWNLITERALDOLLARPLACEHOLDER");
  });

  it("does not turn ordinary dollar text or escaped dollars into math", async () => {
    const markup = await renderMarkdown(
      "It costs $5 to $10 per seat. Escape \\$E=mc^2\\$ when you want literal TeX.",
    );

    expect(markup).toContain("$5 to $10");
    expect(markup).toContain("$E=mc^2$");
    expect(markup).not.toContain('class="katex"');
  });

  it("keeps currency literal without swallowing later inline math", async () => {
    const markup = await renderMarkdown("Price $5. Formula $x$ still renders.");

    expect(markup).toContain("$5. Formula");
    expect(markup).toContain('class="katex"');
    expect(markup).not.toContain("$x$");
  });

  it("keeps all-caps dollar identifiers literal", async () => {
    const markup = await renderMarkdown("Use $USD$ for price and $PATH$ for shell lookup.");

    expect(markup).toContain("$USD$");
    expect(markup).toContain("$PATH$");
    expect(markup).not.toContain('class="katex"');
  });

  it("keeps transcript content routed through the shared renderer", () => {
    const messagesTimelineSource = readFileSync(
      new URL("./chat/MessagesTimeline.tsx", import.meta.url),
      "utf8",
    );

    expect(messagesTimelineSource).toContain('import ChatMarkdown from "../ChatMarkdown"');
    expect(messagesTimelineSource).toContain("<ChatMarkdown");
  });
});

describe("ChatMarkdown user variant", () => {
  it("renders inline markdown formatting", async () => {
    const markup = await renderUserMarkdown("use `bun run test` and **bold** text");

    expect(markup).toContain("chat-markdown--user");
    expect(markup).toContain("<code>bun run test</code>");
    expect(markup).toContain("<strong>bold</strong>");
  });

  it("keeps single newlines as hard breaks", async () => {
    const markup = await renderUserMarkdown("first line\nsecond line");

    expect(markup).toContain("first line<br/>\nsecond line");
  });

  it("keeps dollars literal instead of parsing math", async () => {
    const markup = await renderUserMarkdown("It costs $5 and $x^2$ stays literal.");

    expect(markup).toContain("$5");
    expect(markup).toContain("$x^2$");
    expect(markup).not.toContain('class="katex"');
  });

  it("renders composer skill tokens as chips", async () => {
    const markup = await renderUserMarkdown("run $deep-research on this");

    expect(markup).toContain("Deep Research");
    expect(markup).not.toContain("$deep-research");
  });

  it("keeps composer tokens literal inside inline code", async () => {
    const markup = await renderUserMarkdown("literal `$deep-research` here");

    expect(markup).toContain("<code>$deep-research</code>");
    expect(markup).not.toContain("Deep Research");
  });

  it("keeps Object.prototype member names as literal inline code", async () => {
    for (const token of ["constructor", "__proto__", '"constructor"', '"__proto__"']) {
      const markup = await renderUserMarkdown(`what if a key is \`${token}\``);

      expect(markup).toContain("<code>");
      expect(markup).not.toContain('data-slot="central-icon"');
    }
  });

  it("keeps filename-shaped inline code literal", async () => {
    const markup = await renderUserMarkdown("Review `runtime-AGENTS.md` and `src/index.ts`.");

    expect(markup).toContain("<code>runtime-AGENTS.md</code>");
    expect(markup).toContain("<code>src/index.ts</code>");
    expect(markup).not.toContain('data-slot="central-icon"');
  });

  it("renders @-mention tokens as mention chips", async () => {
    const markup = await renderUserMarkdown("check @src/utils/model.ts please");

    expect(markup).toContain('title="src/utils/model.ts"');
    expect(markup).not.toContain("@src/utils/model.ts");
  });

  it("renders pasted URLs as interactive link chips", async () => {
    const markup = await renderUserMarkdown("see https://example.com/docs now");

    expect(markup).toContain('title="https://example.com/docs"');
    expect(markup).toContain("<button");
  });

  it("renders fenced code with the shared code block chrome", async () => {
    const markup = await renderUserMarkdown(
      ["look at this:", "", "```ts", "const value = 1;", "```"].join("\n"),
    );

    expect(markup).toContain("chat-markdown-codeblock");
    expect(markup).toContain("const value = 1;");
  });
});
