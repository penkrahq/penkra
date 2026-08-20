import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { VoiceRecorderShared } from "./VoiceRecorderShared";

describe("VoiceRecorderShared", () => {
  it("owns only the recording cancel action and shows its progress while transcribing", () => {
    const html = renderToStaticMarkup(
      <VoiceRecorderShared
        durationLabel="0:08"
        isTranscribing
        waveformLevels={[0.2, 0.6, 0.4]}
        onCancel={vi.fn()}
      />,
    );
    const buttons = html.match(/<button[\s\S]*?<\/button>/g) ?? [];

    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain("animate-spin");
  });
});
