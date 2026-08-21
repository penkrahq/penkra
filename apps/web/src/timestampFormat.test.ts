import { describe, expect, it } from "vitest";

import {
  formatMessageTimestamp,
  formatShortTimestamp,
  getTimestampFormatOptions,
} from "./timestampFormat";

describe("getTimestampFormatOptions", () => {
  it("omits hour12 when locale formatting is requested", () => {
    expect(getTimestampFormatOptions("locale", true)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  });

  it("builds a 12-hour formatter with seconds when requested", () => {
    expect(getTimestampFormatOptions("12-hour", true)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  });

  it("builds a 24-hour formatter without seconds when requested", () => {
    expect(getTimestampFormatOptions("24-hour", false)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    });
  });
});

describe("formatMessageTimestamp", () => {
  const localDate = (year: number, month: number, day: number, hour = 12, minute = 19) =>
    new Date(year, month - 1, day, hour, minute);
  const iso = (date: Date) => date.toISOString();
  const time = (date: Date) => formatShortTimestamp(iso(date), "12-hour");

  it("shows only the time for a message from today", () => {
    const messageDate = localDate(2026, 8, 20);

    expect(formatMessageTimestamp(iso(messageDate), "12-hour", localDate(2026, 8, 20, 18))).toBe(
      time(messageDate),
    );
  });

  it("adds the weekday for a message from the preceding six calendar days", () => {
    const messageDate = localDate(2026, 8, 15);
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(messageDate);

    expect(formatMessageTimestamp(iso(messageDate), "12-hour", localDate(2026, 8, 20))).toBe(
      `${weekday} ${time(messageDate)}`,
    );
  });

  it("adds the month and day for an older message in the current year", () => {
    const messageDate = localDate(2026, 8, 6);
    const date = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(messageDate);

    expect(formatMessageTimestamp(iso(messageDate), "12-hour", localDate(2026, 8, 20))).toBe(
      `${date}, ${time(messageDate)}`,
    );
  });

  it("includes the year when the message is from another calendar year", () => {
    const messageDate = localDate(2025, 8, 6);
    const date = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(messageDate);

    expect(formatMessageTimestamp(iso(messageDate), "12-hour", localDate(2026, 8, 20))).toBe(
      `${date}, ${time(messageDate)}`,
    );
  });
});
