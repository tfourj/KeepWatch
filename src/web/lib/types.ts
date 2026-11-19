import type { TimePreferences } from "@shared/time";

export type AppSettings = {
  agentUpdateCheckMinutes: number;
  alertGraceSec: number;
  flapWindowSec: number;
  eventRetentionDays: number;
  historyRetentionDays: number;
  time: TimePreferences;
  templates: Record<string, { title: string; body: string }>;
};

export type SystemInfo = {
  version: string;
  /** Short commit for builds that are not a stable release. */
  commit: string | null;
  baseUrl: string;
  agentRepo: string;
  timezone: string;
};
