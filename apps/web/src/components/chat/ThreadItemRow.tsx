// FILE: ThreadItemRow.tsx
// Purpose: Render one clean-core thread item by kind, feeding the components the
// chat already renders: ChatMarkdown for text/reasoning/user text,
// TimelineWorkEntryRow (through deriveWorkLogEntries) for tool/notice, and
// ComposerPendingUserInputPanel for open questions. The item data -> props
// mapping lives in threadItemMappers.ts.
// Layer: Chat transcript
// Exports: ThreadItemRow

import {
  type ProviderUserInputAnswers,
  type ThreadId,
} from "@penkra/contracts";
import type { CleanCoreThreadItem } from "@penkra/contracts";
import { useMemo, useState } from "react";

import type { TimestampFormat } from "../../appSettings";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { MessageAssistant } from "../middle-panel/message-assistant/MessageAssistant";
import { MessageUser } from "../middle-panel/message-user/MessageUser";
import { ComposerPendingUserInputPanel } from "../middle-panel/composer-user-question/ComposerPendingUserInputPanel";
import {
  buildExpandedImagePreview,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import { FileAttachmentChip } from "./FileAttachmentChip";
import { FileEntryIcon } from "./FileEntryIcon";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  TimelineWorkEntryRow,
  prefersCompactWorkEntryRow,
} from "./TimelineWorkEntryRow";
import {
  USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
  USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
} from "./chatTypography";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import {
  threadItemToPendingUserInput,
  threadItemToUserContent,
  threadItemToWorkLogEntry,
} from "./threadItemMappers";

export interface ThreadItemAnswerInput {
  readonly requestId: string;
  readonly answers: ProviderUserInputAnswers;
  readonly lifecycleGeneration?: string;
}

export interface ThreadItemRowProps {
  readonly item: CleanCoreThreadItem;
  readonly markdownCwd?: string | undefined;
  readonly chatMetaFontSizePx?: number;
  readonly textFontSizePx?: number;
  readonly timestampFormat?: TimestampFormat;
  readonly resolvedTheme?: "light" | "dark";
  readonly onImageExpand?: (preview: ExpandedImagePreview) => void;
  readonly onOpenThread?: (threadId: ThreadId) => void;
  readonly onOpenAgentActivity?: (activityId: string) => void;
  readonly onAnswerQuestion?: (input: ThreadItemAnswerInput) => void;
  readonly answeringRequestId?: string | null;
}

const DEFAULT_CHAT_META_FONT_SIZE_PX = 11;

function useNoopImageExpand(): (preview: ExpandedImagePreview) => void {
  return useMemo(() => () => undefined, []);
}

function ToolOrNoticeItem({ item, props }: { item: CleanCoreThreadItem; props: ThreadItemRowProps }) {
  const workEntry = useMemo(() => threadItemToWorkLogEntry(item), [item]);
  const onImageExpand = props.onImageExpand ?? (() => undefined);
  const textFontSizePx = props.textFontSizePx ?? props.chatMetaFontSizePx;
  if (workEntry === null) {
    return (
      <div
        data-thread-item-kind={item.kind}
        data-thread-item-seq={item.seq}
        data-thread-item-status={item.status}
        className="text-xs text-muted-foreground"
      >
        {item.text ?? ""}
      </div>
    );
  }
  return (
    <div data-thread-item-kind={item.kind} data-thread-item-seq={item.seq}>
      <TimelineWorkEntryRow
        workEntry={workEntry}
        chatMetaFontSizePx={props.chatMetaFontSizePx ?? DEFAULT_CHAT_META_FONT_SIZE_PX}
        {...(textFontSizePx !== undefined ? { textFontSizePx } : {})}
        density={prefersCompactWorkEntryRow(workEntry) ? "compact" : "default"}
        markdownCwd={props.markdownCwd}
        onImageExpand={onImageExpand}
        {...(props.onOpenAgentActivity ? { onOpenAgentActivity: props.onOpenAgentActivity } : {})}
        {...(props.onOpenThread ? { onOpenThread: props.onOpenThread } : {})}
        {...(props.timestampFormat ? { timestampFormat: props.timestampFormat } : {})}
      />
    </div>
  );
}

function QuestionItem({ item, props }: { item: CleanCoreThreadItem; props: ThreadItemRowProps }) {
  const pending = useMemo(() => threadItemToPendingUserInput(item), [item]);
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const isOpen = item.status === "open";
  const isResponding = props.answeringRequestId === pending.requestId;
  const progress = derivePendingUserInputProgress(pending.questions, answers, questionIndex);

  if (!isOpen || pending.questions.length === 0) {
    return (
      <div
        data-thread-item-kind="question"
        data-thread-item-seq={item.seq}
        data-thread-item-status={item.status}
        className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-muted-foreground"
      >
        <div className="text-[length:var(--app-font-size-ui-sm,11px)]">
          {item.status === "answered" ? "Answered" : "Question"}
        </div>
        <ChatMarkdown text={item.text ?? ""} isStreaming={false} cwd={props.markdownCwd} />
      </div>
    );
  }

  return (
    <div data-thread-item-kind="question" data-thread-item-seq={item.seq} data-thread-item-status={item.status}>
      <ComposerPendingUserInputPanel
        pendingUserInputs={[pending]}
        isResponding={isResponding}
        answers={answers}
        questionIndex={questionIndex}
        onToggleOption={(questionId, optionLabel) => {
          const question = pending.questions.find((entry) => entry.id === questionId);
          if (!question) return null;
          const next = togglePendingUserInputOptionSelection(
            question,
            answers[questionId],
            optionLabel,
          );
          setAnswers((existing) => ({ ...existing, [questionId]: next }));
          return next;
        }}
        onAdvance={(overrides) => {
          const merged = overrides ? { ...answers, ...overrides } : answers;
          const resolved = buildPendingUserInputAnswers(pending.questions, merged);
          if (!progress.isLastQuestion) {
            if (resolved || progress.canAdvance || overrides) {
              setQuestionIndex((index) => index + 1);
            }
            return;
          }
          if (!resolved) return;
          props.onAnswerQuestion?.({
            requestId: pending.requestId,
            answers: resolved,
            ...(pending.lifecycleGeneration !== undefined
              ? { lifecycleGeneration: pending.lifecycleGeneration }
              : {}),
          });
        }}
        onPrevious={() => setQuestionIndex((index) => Math.max(index - 1, 0))}
        onCancel={() =>
          props.onAnswerQuestion?.({
            requestId: pending.requestId,
            answers: {},
            ...(pending.lifecycleGeneration !== undefined
              ? { lifecycleGeneration: pending.lifecycleGeneration }
              : {}),
          })
        }
      />
    </div>
  );
}

function TextItem({ item, props }: { item: CleanCoreThreadItem; props: ThreadItemRowProps }) {
  const isStreaming = item.status === "streaming";
  const text = item.text ?? "";
  return (
    <MessageAssistant layoutMode="application">
      <div data-thread-item-kind="text" data-thread-item-seq={item.seq}>
        <ChatMarkdown
          text={text}
          isStreaming={isStreaming}
          cwd={props.markdownCwd}
          {...(props.onImageExpand ? { onImageExpand: props.onImageExpand } : {})}
        />
        {!isStreaming && text.length > 0 ? (
          <div className="mt-1 flex items-center justify-start gap-1 text-muted-foreground/45">
            <MessageCopyButton text={text} label="Copy response" />
          </div>
        ) : null}
      </div>
    </MessageAssistant>
  );
}

function ReasoningItem({ item, props }: { item: CleanCoreThreadItem; props: ThreadItemRowProps }) {
  const [open, setOpen] = useState(false);
  const isStreaming = item.status === "streaming";
  const text = item.text ?? "";
  return (
    <div data-thread-item-kind="reasoning" data-thread-item-seq={item.seq}>
      <div className="flex items-center gap-1 text-muted-foreground/70">
        <button
          type="button"
          className="inline-flex items-center gap-1 transition-colors duration-200 hover:text-muted-foreground/90"
          onClick={() => setOpen((value) => !value)}
        >
          <span>Reasoning</span>
          <DisclosureChevron open={open} className="text-muted-foreground/55" />
        </button>
        {text.length > 0 && !isStreaming ? <MessageCopyButton text={text} /> : null}
      </div>
      <DisclosureRegion open={open} className="mt-1 text-muted-foreground/80">
        <ChatMarkdown
          text={text}
          isStreaming={isStreaming}
          cwd={props.markdownCwd}
          {...(props.onImageExpand ? { onImageExpand: props.onImageExpand } : {})}
        />
      </DisclosureRegion>
    </div>
  );
}

function UserImageThumbnail({
  image,
  images,
  onImageExpand,
  resolvedTheme,
}: {
  image: { id: string; name: string; previewUrl?: string };
  images: ReadonlyArray<{ id: string; name: string; previewUrl?: string }>;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  resolvedTheme: "light" | "dark";
}) {
  return (
    <button
      type="button"
      className="flex size-15 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/70 bg-background/82 text-left transition-colors hover:bg-background/94"
      aria-label={`Preview ${image.name}`}
      title={image.name}
      onClick={() => {
        const preview = buildExpandedImagePreview(images, image.id);
        if (preview) onImageExpand(preview);
      }}
    >
      {image.previewUrl ? (
        <img src={image.previewUrl} alt={image.name} className="size-full object-cover" />
      ) : (
        <FileEntryIcon
          pathValue={image.name}
          kind="file"
          theme={resolvedTheme}
          className="size-4 opacity-70"
        />
      )}
    </button>
  );
}

function UserItem({ item, props }: { item: CleanCoreThreadItem; props: ThreadItemRowProps }) {
  const content = useMemo(() => threadItemToUserContent(item), [item]);
  const fallbackImageExpand = useNoopImageExpand();
  const onImageExpand = props.onImageExpand ?? fallbackImageExpand;
  const resolvedTheme = props.resolvedTheme ?? "dark";
  const images = content.attachments.filter(
    (attachment): attachment is Extract<typeof attachment, { type: "image" }> =>
      attachment.type === "image",
  );
  const files = content.attachments.filter(
    (attachment): attachment is Extract<typeof attachment, { type: "file" }> =>
      attachment.type === "file",
  );
  const showText = content.text.trim().length > 0;
  return (
    <MessageUser layoutMode="application" className="flex flex-col gap-2">
      <div className="flex w-full justify-end">
        <div className="flex max-w-[80%] flex-col items-end gap-1">
          {files.length > 0 ? (
            <div className="flex max-w-[280px] flex-wrap justify-end gap-1.5 self-end">
              {files.map((file) => (
                <FileAttachmentChip key={file.id} file={file} />
              ))}
            </div>
          ) : null}
          {images.length > 0 ? (
            <div className="flex max-w-[240px] flex-wrap justify-end gap-2 self-end">
              {images.map((image) => (
                <UserImageThumbnail
                  key={image.id}
                  image={image}
                  images={images}
                  onImageExpand={onImageExpand}
                  resolvedTheme={resolvedTheme}
                />
              ))}
            </div>
          ) : null}
          {showText ? (
            <div
              data-thread-item-kind="user"
              data-thread-item-seq={item.seq}
              className={cn(
                "w-max max-w-full min-w-0 self-end bg-[var(--app-user-message-background)]",
                USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
                USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
              )}
            >
              <ChatMarkdown
                variant="user"
                text={content.text}
                cwd={props.markdownCwd}
                mentionReferences={content.mentions}
                className="font-system-ui"
              />
            </div>
          ) : (
            <span data-thread-item-kind="user" data-thread-item-seq={item.seq} />
          )}
          {showText ? (
            <div className="flex items-center justify-end text-muted-foreground/45">
              <MessageCopyButton text={content.text} />
            </div>
          ) : null}
        </div>
      </div>
    </MessageUser>
  );
}

export function ThreadItemRow(props: ThreadItemRowProps) {
  const { item } = props;
  switch (item.kind) {
    case "user":
      return <UserItem item={item} props={props} />;
    case "text":
      return <TextItem item={item} props={props} />;
    case "reasoning":
      return <ReasoningItem item={item} props={props} />;
    case "tool":
    case "notice":
      return <ToolOrNoticeItem item={item} props={props} />;
    case "question":
      return <QuestionItem item={item} props={props} />;
    default:
      return <ToolOrNoticeItem item={item} props={props} />;
  }
}
