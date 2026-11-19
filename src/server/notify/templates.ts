import { getSettings } from "../settings";
import { TEMPLATE_VARIABLES, type EventType } from "../../shared/events";
import type { TemplateVars } from "../../shared/templates";
import { formatEventTime } from "../../shared/time";

/** Event time in the chosen timezone and clock, falling back to `TZ`. */
export function formatTime(date: Date): string {
  const { timezone, timeFormat } = getSettings().time;
  return formatEventTime(date, timezone ?? (process.env.TZ || undefined), timeFormat);
}

export type TemplateEvent = {
  type: EventType | string;
  title: string;
  message: string;
  createdAt: Date;
  data?: Record<string, unknown> | null;
};

/** Values for every template variable. Missing values are empty, so lines that only use them are left out. */
export function templateVars(event: TemplateEvent): TemplateVars {
  const d = event.data ?? {};
  const str = (v: unknown) => (v === null || v === undefined ? "" : Array.isArray(v) ? v.join(", ") : String(v));
  const vars: TemplateVars = {};
  for (const name of TEMPLATE_VARIABLES) vars[name] = str(d[name]);
  return {
    ...vars,
    event: event.type,
    title: event.title,
    message: event.message,
    time: formatTime(event.createdAt),
  };
}
