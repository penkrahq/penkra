import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ComposerVoiceRecorderBar } from "./ComposerVoiceRecorderBar";

describe("ComposerVoiceRecorderBar", () => {
  it("shows one progress spinner and keeps the send arrow disabled while transcribing", () => {
    const html = renderToStaticMarkup(
      <ComposerVoiceRecorderBar
        durationLabel="0:08"
        isRecording={false}
        isTranscribing
        waveformLevels={[0.2, 0.6, 0.4]}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    const buttons = html.match(/<button[\s\S]*?<\/button>/g) ?? [];

    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toContain("animate-spin");
    expect(buttons[1]).toContain("disabled");
    expect(buttons[1]).not.toContain("animate-spin");
  });
});
