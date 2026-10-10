import { describe, expect, it } from "vitest";

import {
  formatSubagentModelLabel,
  humanizeSubagentStatus,
  normalizeSubagentStatusKind,
  resolveSubagentPresentation,
  subagentAccentColor,
} from "./WorkflowRunCard.logic";

describe("resolveSubagentPresentation", () => {
  it("prefers explicit nickname and role over generic thread titles", () => {
    const presentation = resolveSubagentPresentation({
      nickname: "Halley",
      role: "Explorer",
      title: "New Thread",
      fallbackId: "subagent:thread-1",
    });

    expect(presentation.primaryLabel).toBe("Halley");
    expect(presentation.nickname).toBe("Halley");
    expect(presentation.role).toBe("explorer");
    expect(presentation.fullLabel).toBe("Halley [explorer]");
  });

  it("parses bracketed labels from child-thread titles", () => {
    const presentation = resolveSubagentPresentation({
      title: "Harvey [worker]",
      fallbackId: "subagent:thread-2",
    });

    expect(presentation.nickname).toBe("Harvey");
    expect(presentation.role).toBe("worker");
    expect(presentation.primaryLabel).toBe("Harvey");
  });

  it("hides worker-tier agent types passed as explicit roles", () => {
    const presentation = resolveSubagentPresentation({
      nickname: "Halley",
      role: "worker-low",
      title: null,
      fallbackId: "subagent:thread-1",
    });

    expect(presentation.role).toBeNull();
    expect(presentation.primaryLabel).toBe("Halley");
    expect(presentation.fullLabel).toBe("Halley");
  });

  it("strips worker-tier suffixes baked into persisted thread titles", () => {
    const presentation = resolveSubagentPresentation({
      title: "Research scheduling market - players [worker-medium]",
      fallbackId: "subagent:thread-2",
    });

    expect(presentation.nickname).toBe("Research scheduling market - players");
    expect(presentation.role).toBeNull();
    expect(presentation.primaryLabel).toBe("Research scheduling market - players");
    expect(presentation.fullLabel).toBe("Research scheduling market - players");
  });

  it("falls back past worker-tier-only placeholder titles", () => {
    const presentation = resolveSubagentPresentation({
      title: "Subagent [worker-high]",
      fallbackId: "subagent:thread-1:agent-1",
    });

    expect(presentation.role).toBeNull();
    expect(presentation.title).toBeNull();
    expect(presentation.primaryLabel).toBe("agent-1");
  });

  it("treats provider-id placeholder titles as generic subagent labels", () => {
    const presentation = resolveSubagentPresentation({
      title: "Subagent 019d8cae-0628-7bf1-bf86-5cbc31cd582c",
      fallbackId: "subagent:thread-1:agent-1",
    });

    expect(presentation.title).toBeNull();
    expect(presentation.primaryLabel).toBe("agent-1");
  });

  it("keeps readable provider ids intact until richer metadata arrives", () => {
    const presentation = resolveSubagentPresentation({
      title: "Subagent 019d8cae-0628-7bf1-bf86-5cbc31cd582c",
      fallbackId: "subagent:thread-1:019d8cae-0628-7bf1-bf86-5cbc31cd582c",
    });

    expect(presentation.primaryLabel).toBe("019d8cae-0628-7bf1-bf86-5cbc31cd582c");
  });
});

describe("subagentAccentColor", () => {
  it("stays stable for the same nickname", () => {
    expect(subagentAccentColor("Halley")).toBe(subagentAccentColor("Halley"));
  });
});

describe("normalizeSubagentStatusKind", () => {
  it("maps common provider statuses into Remodex-style buckets", () => {
    expect(normalizeSubagentStatusKind("in_progress")).toBe("running");
    expect(normalizeSubagentStatusKind("completed")).toBe("completed");
    expect(normalizeSubagentStatusKind("errored")).toBe("failed");
    expect(normalizeSubagentStatusKind("interrupted")).toBe("stopped");
    expect(normalizeSubagentStatusKind("pending")).toBe("queued");
    expect(normalizeSubagentStatusKind("idle")).toBe("idle");
  });
});

describe("humanizeSubagentStatus", () => {
  it("returns readable labels for normalized statuses", () => {
    expect(humanizeSubagentStatus("in_progress")).toBe("Running");
    expect(humanizeSubagentStatus("completed")).toBe("Completed");
    expect(humanizeSubagentStatus("unknown")).toBeUndefined();
  });
});

describe("formatSubagentModelLabel", () => {
  it("humanizes Codex-shaped model ids for display", () => {
    expect(formatSubagentModelLabel("gpt-5.4-mini")).toBe("GPT-5.4 Mini");
    expect(formatSubagentModelLabel("gpt-5.3-codex-spark")).toBe("GPT-5.3 Codex Spark");
  });

  it("humanizes unknown GPT subagent models", () => {
    expect(formatSubagentModelLabel("gpt-5.1-codex-max")).toBe("GPT-5.1 Codex Max");
  });

  it("drops only the redundant Claude prefix without guessing version aliases", () => {
    expect(formatSubagentModelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4 5 20251001");
    expect(formatSubagentModelLabel("claude-sonnet-4-6")).toBe("Sonnet 4 6");
    expect(formatSubagentModelLabel("haiku")).toBe("Haiku");
  });
});
