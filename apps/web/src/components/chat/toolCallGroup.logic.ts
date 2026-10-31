// The shared implementation serves both the web and the phone-facing server.
import type { WorkLogEntry } from "../../session-logic";
import type { ToolCallGroupSummary as SharedSummary } from "@penkra/shared/toolCallGroup";

export {
  MIN_COLLAPSIBLE_TOOL_GROUP_SIZE,
  isSummarizableToolCallEntry,
  classifyToolCallSummaryCategory,
  summarizeToolCallGroup,
  type ToolCallGroupSummaryPart,
  type ToolCallSummaryCategory,
} from "@penkra/shared/toolCallGroup";
export type ToolCallGroupSummary = SharedSummary<WorkLogEntry>;
