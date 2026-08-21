import { type TimestampFormat } from "./appSettings";

export function getTimestampFormatOptions(
  timestampFormat: TimestampFormat,
  includeSeconds: boolean,
): Intl.DateTimeFormatOptions {
  const baseOptions: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
  };

  if (timestampFormat === "locale") {
    return baseOptions;
  }

  return {
    ...baseOptions,
    hour12: timestampFormat === "12-hour",
  };
}

const timestampFormatterCache = new Map<string, Intl.DateTimeFormat>();
const messageDateFormatterCache = new Map<
  "weekday" | "month-day" | "month-day-year",
  Intl.DateTimeFormat
>();

function getTimestampFormatter(
  timestampFormat: TimestampFormat,
  includeSeconds: boolean,
): Intl.DateTimeFormat {
  const cacheKey = `${timestampFormat}:${includeSeconds ? "seconds" : "minutes"}`;
  const cachedFormatter = timestampFormatterCache.get(cacheKey);
  if (cachedFormatter) {
    return cachedFormatter;
  }

  const formatter = new Intl.DateTimeFormat(
    undefined,
    getTimestampFormatOptions(timestampFormat, includeSeconds),
  );
  timestampFormatterCache.set(cacheKey, formatter);
  return formatter;
}

export function formatTimestamp(isoDate: string, timestampFormat: TimestampFormat): string {
  return getTimestampFormatter(timestampFormat, true).format(new Date(isoDate));
}

export function formatShortTimestamp(isoDate: string, timestampFormat: TimestampFormat): string {
  return getTimestampFormatter(timestampFormat, false).format(new Date(isoDate));
}

function isSameLocalDate(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function getMessageDateFormatter(
  style: "weekday" | "month-day" | "month-day-year",
): Intl.DateTimeFormat {
  const cachedFormatter = messageDateFormatterCache.get(style);
  if (cachedFormatter) {
    return cachedFormatter;
  }

  const formatter = new Intl.DateTimeFormat(
    undefined,
    style === "weekday"
      ? { weekday: "long" }
      : {
          month: "short",
          day: "numeric",
          ...(style === "month-day-year" ? { year: "numeric" } : {}),
        },
  );
  messageDateFormatterCache.set(style, formatter);
  return formatter;
}

/**
 * Keeps today's message metadata compact while restoring enough calendar context
 * to distinguish older turns in a long-lived thread.
 */
export function formatMessageTimestamp(
  isoDate: string,
  timestampFormat: TimestampFormat,
  referenceDate = new Date(),
): string {
  const messageDate = new Date(isoDate);
  const time = getTimestampFormatter(timestampFormat, false).format(messageDate);

  if (isSameLocalDate(messageDate, referenceDate)) {
    return time;
  }

  const recentDateCutoff = new Date(
    referenceDate.getFullYear(),
    referenceDate.getMonth(),
    referenceDate.getDate() - 6,
  );
  const messageDay = new Date(
    messageDate.getFullYear(),
    messageDate.getMonth(),
    messageDate.getDate(),
  );
  const referenceDay = new Date(
    referenceDate.getFullYear(),
    referenceDate.getMonth(),
    referenceDate.getDate(),
  );

  if (messageDay >= recentDateCutoff && messageDay < referenceDay) {
    return `${getMessageDateFormatter("weekday").format(messageDate)} ${time}`;
  }

  const dateStyle =
    messageDate.getFullYear() === referenceDate.getFullYear() ? "month-day" : "month-day-year";
  return `${getMessageDateFormatter(dateStyle).format(messageDate)}, ${time}`;
}
