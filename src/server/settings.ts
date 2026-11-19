import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db/client";
import { settings } from "./db/schema";
import { DEFAULT_TIME_PREFERENCES, TIME_FORMATS, TIME_STYLES, isValidTimeZone } from "../shared/time";

export const appSettingsSchema = z.object({
  agentUpdateCheckMinutes: z.number().int().min(5).max(1440).default(15),
  /** Extra seconds on top of three advert intervals before split brain or no master is reported. */
  alertGraceSec: z.number().int().min(0).max(600).default(10),
  /** Failovers of one VIP within this window are sent as one notification. */
  flapWindowSec: z.number().int().min(0).max(3600).default(120),
  eventRetentionDays: z.number().int().min(1).max(3650).default(90),
  historyRetentionDays: z.number().int().min(1).max(3650).default(90),
  time: z
    .object({
      timezone: z.string().refine(isValidTimeZone, "Unknown timezone").nullable().default(null),
      timeFormat: z.enum(TIME_FORMATS).default("auto"),
      timeStyle: z.enum(TIME_STYLES).default("relative"),
    })
    .default(DEFAULT_TIME_PREFERENCES),
  templates: z
    .record(z.string().max(64), z.object({ title: z.string().max(500), body: z.string().max(4000) }))
    .default({}),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

const KEY = "app";
let cache: AppSettings | null = null;

export function getSettings(): AppSettings {
  if (cache) return cache;
  const row = db.select().from(settings).where(eq(settings.key, KEY)).get();
  const raw = row ? JSON.parse(row.value) : {};
  const parsed = appSettingsSchema.safeParse(raw);
  cache = parsed.success ? parsed.data : appSettingsSchema.parse({});
  return cache;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next = appSettingsSchema.parse({ ...getSettings(), ...patch });
  const value = JSON.stringify(next);
  db.insert(settings)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
    .run();
  cache = next;
  return next;
}
