import { describe, expect, it } from "vitest";
import { resolveHttpByteRange } from "./httpByteRange";

describe("HTTP byte ranges", () => {
  it.each([
    ["bytes=2-4", 10, { start: 2, end: 4 }],
    ["bytes=7-", 10, { start: 7, end: 9 }],
    ["bytes=-3", 10, { start: 7, end: 9 }],
    ["bytes=0-99", 10, { start: 0, end: 9 }],
    ["bytes=-99", 10, { start: 0, end: 9 }],
    ["bytes=10-", 10, "unsatisfiable"],
    ["bytes=4-2", 10, "unsatisfiable"],
    ["bytes=-0", 10, "unsatisfiable"],
    ["bytes=0-", 0, "unsatisfiable"],
    ["bytes=9007199254740992-", 10, "unsatisfiable"],
    ["bytes=0-2,4-6", 10, null],
    ["items=0-2", 10, null],
    ["bytes=-", 10, null],
    [undefined, 10, null],
  ])("resolves %s over %s bytes", (header, size, expected) => {
    expect(resolveHttpByteRange(header, size)).toEqual(expected);
  });
});
