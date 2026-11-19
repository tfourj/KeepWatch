import type { TimeOptions } from "@shared/templates";
import { DEFAULT_TIME_PREFERENCES, hourCycleFor, type TimePreferences } from "@shared/time";

let timePreferences: TimePreferences = DEFAULT_TIME_PREFERENCES;
let serverTimezone: string | undefined;

/** Set the time display used by every formatter below. Pages remount when it changes. */
export function setTimePreferences(prefs: TimePreferences, serverZone?: string) {
  timePreferences = prefs;
  serverTimezone = serverZone;
}

/** Timezone and clock the server uses for `{time}` in notifications. */
export function notificationTimeOptions(): TimeOptions {
  return { timeZone: timePreferences.timezone ?? serverTimezone, timeFormat: timePreferences.timeFormat };
}

export function currentTimePreferences(): TimePreferences {
  return timePreferences;
}

/** Timezone and hour cycle from the time display, merged into `options`. */
export function withTimePreferences(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions {
  const { timezone, timeFormat } = timePreferences;
  return { ...options, timeZone: timezone ?? undefined, hourCycle: hourCycleFor(timeFormat) };
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "5 minutes ago", or the full date and time when absolute times are chosen. */
export function timeAgo(value: string | number | Date | null | undefined): string {
  if (!value) return "never";
  if (timePreferences.timeStyle === "absolute") return formatDateTime(value);
  const diff = (new Date(value).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (!value) return "-";
  return new Date(value).toLocaleString(undefined, withTimePreferences({ dateStyle: "medium", timeStyle: "short" }));
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
