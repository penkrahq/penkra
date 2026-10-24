import { describe, expect, it } from "vitest";
import { wsTextChunks } from "./wsTextChunks";
import { encodeTunnelEnvelope } from "./tunnelCodec";
import { NOISE_MAX_MESSAGE_BYTES } from "./noise";

describe("WebSocket tunnel text chunks", () => {
  it.each(["", "ordinary RPC", "😀é漢".repeat(40_000), '\u0000\n\t"\\'.repeat(40_000)])(
    "round trips without splitting Unicode and includes exact JSON overhead (case %#)",
    (text) => {
      const chunks = [...wsTextChunks({ id: Number.MAX_SAFE_INTEGER, seq: 98, text })];
      expect(chunks.map((chunk) => chunk.data).join("")).toBe(text);
      for (const [index, chunk] of chunks.entries()) {
        expect(chunk.seq).toBe(98 + index);
        expect(chunk.more).toBe(index === chunks.length - 1 ? undefined : true);
        expect(encodeTunnelEnvelope(chunk).length + 16).toBeLessThanOrEqual(
          NOISE_MAX_MESSAGE_BYTES,
        );
        expect(Buffer.from(chunk.data).toString()).toBe(chunk.data);
      }
    },
  );
  it("does not accept isolated surrogate code units", () => {
    for (const text of ["\ud800", "\udc00"])
      expect(() => [...wsTextChunks({ id: 1, seq: 0, text })]).toThrow("invalid-envelope");
  });
});
