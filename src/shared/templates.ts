import { DEFAULT_TEMPLATE, type EventType } from "./events";
import { formatEventTime, type TimeFormat } from "./time";

export type TemplateVars = Record<string, string>;

export type Template = { title: string; body: string };

const PLACEHOLDER = /\{([a-z_]+)\}/gi;

/** A line is dropped when it has placeholders and every one of them is empty for this event. */
function hasOnlyEmptyValues(line: string, vars: TemplateVars): boolean {
  const names = [...line.matchAll(PLACEHOLDER)].map((match) => match[1]);
  return names.length > 0 && names.every((name) => vars[name] === "");
}

/**
 * Replace {name} placeholders. Unknown placeholders are left untouched, and lines whose values are
 * all empty are left out.
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  const lines = template.split("\n");
  const kept = lines.filter((line) => !hasOnlyEmptyValues(line, vars));
  const text = kept.join("\n").replace(PLACEHOLDER, (match, name: string) => (name in vars ? vars[name] : match));
  return kept.length < lines.length ? text.trim() : text;
}

/** Render a notification. A title or body that comes out empty falls back to the event's own. */
export function renderMessage(template: Template, vars: TemplateVars): Template {
  return {
    title: renderTemplate(template.title, vars) || vars.title || "",
    body: renderTemplate(template.body, vars) || vars.message || "",
  };
}

/** Channel override first, then the global template for the event type, then the default. */
export function resolveTemplate(
  eventType: string,
  global: Record<string, Template>,
  channel: { titleTemplate?: string | null; bodyTemplate?: string | null },
): Template {
  const base = global[eventType] ?? DEFAULT_TEMPLATE;
  return {
    title: channel.titleTemplate?.trim() ? channel.titleTemplate : base.title,
    body: channel.bodyTemplate?.trim() ? channel.bodyTemplate : base.body,
  };
}

type Sample = { title: string; message: string; vars?: Partial<TemplateVars> };

const SAMPLE_VARS: TemplateVars = {
  cluster: "edge",
  vip: "VI_web",
  address: "10.0.0.10",
  node: "lb1",
  from: "",
  to: "",
  state: "",
  priority: "",
  check: "",
  reason: "",
  count: "",
  version: "",
  error: "",
  duration: "",
};

/** Agent and account events are not about a VIP. */
const NO_VIP: Partial<TemplateVars> = { cluster: "", vip: "", address: "" };

/** Example events used to preview templates in the UI. */
const SAMPLES: Record<EventType, Sample> = {
  failover: {
    title: "VI_web moved to lb2",
    message: "VI_web (10.0.0.10) moved from lb1 to lb2: lb1 is in FAULT",
    vars: { node: "lb2", from: "lb1", to: "lb2", reason: "lb1 is in FAULT" },
  },
  split_brain: {
    title: "Split brain on VI_web",
    message: "lb1, lb2 all hold VI_web (10.0.0.10). Check the network between them.",
    vars: { node: "lb1, lb2", count: "2" },
  },
  split_brain_resolved: {
    title: "VI_web has one master again",
    message: "Split brain on VI_web (10.0.0.10) is resolved",
    vars: { node: "" },
  },
  no_master: { title: "VI_web has no master", message: "No node holds VI_web (10.0.0.10)", vars: { node: "" } },
  master_restored: { title: "VI_web has a master again", message: "lb2 holds VI_web (10.0.0.10) again" },
  instance_fault: {
    title: "VI_web in FAULT on lb1",
    message: "VI_web (10.0.0.10) went from MASTER to FAULT on lb1",
    vars: { from: "MASTER", to: "FAULT", state: "FAULT" },
  },
  instance_recovered: {
    title: "VI_web recovered on lb1",
    message: "VI_web (10.0.0.10) is BACKUP again on lb1",
    vars: { from: "FAULT", to: "BACKUP", state: "BACKUP" },
  },
  check_failed: {
    title: "web failing on lb1",
    message: "Health check web on lb1 failed: connection refused",
    vars: { check: "web", error: "connection refused", vip: "", address: "" },
  },
  check_recovered: {
    title: "web healthy on lb1",
    message: "Health check web on lb1 passes again",
    vars: { check: "web", vip: "", address: "" },
  },
  maintenance_on: {
    title: "Maintenance on for VI_web on lb1",
    message: "lb1 gave up VI_web (10.0.0.10) for maintenance",
  },
  maintenance_off: {
    title: "Maintenance off for VI_web on lb1",
    message: "lb1 takes part in VI_web (10.0.0.10) again",
  },
  keepalived_service_failed: {
    title: "lb1: keepalived is failed",
    message: "lb1: keepalived is failed",
    vars: { vip: "", address: "", state: "failed", error: "keepalived is failed" },
  },
  keepalived_service_recovered: {
    title: "keepalived running on lb1",
    message: "keepalived on lb1 runs again",
    vars: { vip: "", address: "" },
  },
  config_applied: {
    title: "Config applied to edge",
    message: "Applied the keepalived config to 2 nodes of edge",
    vars: { vip: "", address: "", node: "", count: "2" },
  },
  config_failed: {
    title: "Config not applied on lb1",
    message: "lb1: keepalived rejected the config: Unknown keyword 'bogus'",
    vars: { vip: "", address: "", error: "keepalived rejected the config" },
  },
  config_rolled_back: {
    title: "Config rolled back on lb1",
    message: "lb1: rolled back: keepalived is failed",
    vars: { vip: "", address: "", error: "keepalived is failed" },
  },
  config_drift: {
    title: "lb1: keepwatch.conf was changed outside KeepWatch",
    message: "lb1: keepwatch.conf was changed outside KeepWatch",
    vars: { vip: "", address: "" },
  },
  agent_connected: {
    title: "lb1 connected",
    message: "Agent on lb1 connected (v1.4.0)",
    vars: { ...NO_VIP, version: "1.4.0" },
  },
  agent_disconnected: { title: "lb1 disconnected", message: "Agent on lb1 lost its connection", vars: NO_VIP },
  agent_enrolled: {
    title: "lb1 paired",
    message: "Agent on lb1 paired with lb1 (v1.4.0)",
    vars: { ...NO_VIP, version: "1.4.0" },
  },
  agent_update_available: {
    title: "Agent update available for lb1",
    message: "Agent v1.5.0 is available for lb1 (running v1.4.0)",
    vars: { ...NO_VIP, version: "1.5.0" },
  },
  agent_updated: {
    title: "3 agents updated",
    message: "Agents on lb1, lb2 and lb3 updated to v1.5.0",
    vars: { ...NO_VIP, node: "lb1, lb2, lb3", count: "3", version: "1.5.0" },
  },
  agent_update_failed: {
    title: "Agent update failed on lb1",
    message: "Agent on lb1 could not update: checksum mismatch",
    vars: { ...NO_VIP, error: "checksum mismatch" },
  },
  login: {
    title: "New sign-in to KeepWatch",
    message: "admin@example.com signed in with password and authenticator app from Chrome on macOS (203.0.113.7)",
    vars: { ...NO_VIP, node: "" },
  },
  test: {
    title: "KeepWatch test notification",
    message: 'This is a test from KeepWatch for channel "Phone".',
  },
};

/** Timezone and clock used for `{time}`, as the server would format it. */
export type TimeOptions = { timeZone?: string; timeFormat?: TimeFormat };

/** Variables for an example event of the given type, as the server would build them. */
export function sampleTemplateVars(eventType: EventType, now = new Date(), time: TimeOptions = {}): TemplateVars {
  const sample = SAMPLES[eventType];
  return {
    ...SAMPLE_VARS,
    ...sample.vars,
    event: eventType,
    title: sample.title,
    message: sample.message,
    time: formatEventTime(now, time.timeZone, time.timeFormat),
  } as TemplateVars;
}

/** Render a template against an example event of the given type. */
export function previewTemplate(
  eventType: EventType,
  template: Template,
  now = new Date(),
  time: TimeOptions = {},
): Template {
  return renderMessage(template, sampleTemplateVars(eventType, now, time));
}
