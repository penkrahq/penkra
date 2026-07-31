// FILE: chatHotPath.compiler.test.ts
// Purpose: Prevent silent React Compiler bailouts in the composer-to-transcript
//          render boundary. A bailout here makes long transcripts rerender on
//          every composer keystroke.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import { describe, expect, it } from "vitest";

interface CompilerEvent {
  readonly kind: string;
  readonly fnName?: string | null | undefined;
  readonly detail?: { readonly reason?: string; readonly description?: string } | undefined;
}

function compileEvents(filePath: string): CompilerEvent[] {
  const events: CompilerEvent[] = [];
  transformSync(readFileSync(filePath, "utf8"), {
    filename: filePath,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    plugins: [
      [
        "babel-plugin-react-compiler",
        {
          panicThreshold: "none",
          logger: {
            logEvent: (_fn: unknown, event: CompilerEvent) => {
              events.push(event);
            },
          },
        },
      ],
    ],
  });
  return events;
}

const HOT_PATH_MODULES = [
  { relativePath: "ChatView.tsx", allowedBailoutReasons: [] },
  {
    relativePath: "chat/MessagesTimeline.tsx",
    // useStableRows intentionally reuses row identities through a render-time ref.
    allowedBailoutReasons: ["Cannot access refs during render"],
  },
  { relativePath: "chat/ChatTranscriptPane.tsx", allowedBailoutReasons: [] },
] as const;

describe("chat hot-path React Compiler coverage", () => {
  for (const module of HOT_PATH_MODULES) {
    it(`compiles ${module.relativePath} without unexpected bailouts`, () => {
      const events = compileEvents(join(import.meta.dirname, module.relativePath));
      const bailoutReasons = events
        .filter((event) => event.kind === "CompileError")
        .map((event) => event.detail?.reason ?? event.detail?.description ?? "unknown")
        .sort();

      expect(
        bailoutReasons,
        JSON.stringify(
          events.filter((event) => event.kind === "CompileError"),
          null,
          2,
        ),
      ).toEqual([...module.allowedBailoutReasons].sort());
      expect(events.some((event) => event.kind === "CompileSuccess")).toBe(true);
    }, 240_000);
  }
});
