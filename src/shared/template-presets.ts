import { DEFAULT_TEMPLATE, EVENT_TYPES, type EventType } from "./events";
import type { Template } from "./templates";

export type TemplatePreset = { id: string; label: string; templates: Record<EventType, Template> };

type Detail =
  | "cluster"
  | "vip"
  | "address"
  | "node"
  | "from"
  | "to"
  | "state"
  | "check"
  | "reason"
  | "version"
  | "error"
  | "time";

/** One line per value. Lines whose value is empty for an event are left out when rendering. */
const DETAILS: Record<Detail, { icon: string; text: string }> = {
  cluster: { icon: "🗂️", text: "Cluster {cluster}" },
  vip: { icon: "🔀", text: "VIP {vip}" },
  address: { icon: "🌐", text: "{address}" },
  node: { icon: "🖥️", text: "{node}" },
  from: { icon: "⬅️", text: "From {from}" },
  to: { icon: "➡️", text: "To {to}" },
  state: { icon: "📊", text: "State {state}" },
  check: { icon: "🩺", text: "Check {check}" },
  reason: { icon: "💬", text: "{reason}" },
  version: { icon: "🏷️", text: "Version {version}" },
  error: { icon: "❗", text: "{error}" },
  time: { icon: "🕒", text: "{time}" },
};

type EventSpec = {
  icon: string;
  /** The message in the template's own words. */
  summary: string;
  /** Values that matter most for the event. */
  key: Detail[];
  /** Further values shown by the detailed presets. */
  more: Detail[];
};

const EVENTS: Record<EventType, EventSpec> = {
  failover: {
    icon: "🔀",
    summary: "{vip} moved to {to}",
    key: ["address", "from", "reason"],
    more: ["cluster", "time"],
  },
  split_brain: {
    icon: "🚨",
    summary: "More than one node holds {vip}",
    key: ["address", "node"],
    more: ["cluster", "time"],
  },
  split_brain_resolved: {
    icon: "✅",
    summary: "{vip} has one master again",
    key: ["address"],
    more: ["cluster", "time"],
  },
  no_master: { icon: "❌", summary: "No node holds {vip}", key: ["address"], more: ["cluster", "time"] },
  master_restored: { icon: "✅", summary: "{node} holds {vip} again", key: ["address"], more: ["cluster", "time"] },
  instance_fault: {
    icon: "⚠️",
    summary: "{vip} is in FAULT on {node}",
    key: ["address", "from"],
    more: ["cluster", "time"],
  },
  instance_recovered: { icon: "✅", summary: "{vip} recovered on {node}", key: ["state"], more: ["cluster", "time"] },
  check_failed: { icon: "🩺", summary: "{check} is failing on {node}", key: ["error"], more: ["cluster", "time"] },
  check_recovered: { icon: "✅", summary: "{check} passes again on {node}", key: [], more: ["cluster", "time"] },
  maintenance_on: { icon: "🛠️", summary: "{node} gave up {vip} for maintenance", key: ["address"], more: ["time"] },
  maintenance_off: { icon: "🛠️", summary: "{node} serves {vip} again", key: ["address"], more: ["time"] },
  keepalived_service_failed: {
    icon: "🛑",
    summary: "keepalived stopped on {node}",
    key: ["state"],
    more: ["cluster", "time"],
  },
  keepalived_service_recovered: {
    icon: "✅",
    summary: "keepalived runs again on {node}",
    key: [],
    more: ["cluster", "time"],
  },
  config_applied: { icon: "📦", summary: "Config applied to {cluster}", key: [], more: ["time"] },
  config_failed: { icon: "❌", summary: "Config not applied on {node}", key: ["error"], more: ["cluster", "time"] },
  config_rolled_back: {
    icon: "↩️",
    summary: "Config rolled back on {node}",
    key: ["error"],
    more: ["cluster", "time"],
  },
  config_drift: { icon: "✏️", summary: "The config on {node} was edited by hand", key: [], more: ["cluster", "time"] },
  agent_connected: { icon: "🔗", summary: "Agent on {node} connected", key: ["version"], more: ["time"] },
  agent_disconnected: { icon: "🔌", summary: "Agent on {node} disconnected", key: [], more: ["time"] },
  agent_enrolled: { icon: "🤝", summary: "Agent paired with {node}", key: ["version"], more: ["time"] },
  agent_update_available: { icon: "🆕", summary: "Agent update for {node}", key: ["version"], more: ["time"] },
  agent_updated: { icon: "⬆️", summary: "Agent on {node} updated", key: ["version"], more: ["time"] },
  agent_update_failed: {
    icon: "⚠️",
    summary: "Agent on {node} could not update",
    key: ["error"],
    more: ["version", "time"],
  },
  login: { icon: "🔐", summary: "{message}", key: [], more: ["time"] },
  test: { icon: "🧪", summary: "{message}", key: [], more: ["time"] },
};

type LineStyle = "text" | "icon" | "icon-text";

function detailLine(detail: Detail, style: LineStyle): string {
  const { icon, text } = DETAILS[detail];
  if (style === "text") return text;
  return style === "icon" ? `${icon} {${detail}}` : `${icon} ${text}`;
}

function body(lead: string, details: Detail[], style: LineStyle, gap = "\n"): string {
  const lines = details.map((detail) => detailLine(detail, style)).join("\n");
  if (!lead) return lines || "{message}";
  return lines ? `${lead}${gap}${lines}` : lead;
}

function forEachEvent(build: (spec: EventSpec) => Template): Record<EventType, Template> {
  return Object.fromEntries(EVENT_TYPES.map((type) => [type, build(EVENTS[type])])) as Record<EventType, Template>;
}

const iconTitle = (spec: EventSpec) => `${spec.icon} {title}`;

/** Ready-made template sets. The first one is the built-in default. */
export const TEMPLATE_PRESETS: TemplatePreset[] = [
  { id: "default", label: "Default", templates: forEachEvent(() => DEFAULT_TEMPLATE) },
  {
    id: "minimal",
    label: "Minimalistic",
    templates: forEachEvent((spec) => ({ title: "{title}", body: body("", spec.key, "text") })),
  },
  {
    id: "detailed",
    label: "Detailed",
    templates: forEachEvent((spec) => ({
      title: "{title}",
      // The message already states the error.
      body: body(
        "{message}",
        [...spec.key, ...spec.more].filter((d) => d !== "error"),
        "text",
        "\n\n",
      ),
    })),
  },
  {
    id: "icon-default",
    label: "Icon Default",
    templates: forEachEvent((spec) => ({ title: iconTitle(spec), body: body(spec.summary, spec.key, "icon-text") })),
  },
  {
    id: "icon-minimal",
    label: "Icon Minimalistic",
    templates: forEachEvent((spec) => ({ title: iconTitle(spec), body: body("", spec.key, "icon") })),
  },
  {
    id: "icon-detailed",
    label: "Icon Detailed",
    templates: forEachEvent((spec) => ({
      title: iconTitle(spec),
      body: body(spec.summary, [...spec.key, ...spec.more], "icon-text"),
    })),
  },
];

/** The preset whose templates equal the given ones for every event type, if any. */
export function matchTemplatePreset(templates: Record<string, Template>): TemplatePreset | undefined {
  return TEMPLATE_PRESETS.find((preset) =>
    EVENT_TYPES.every((type) => {
      const current = templates[type] ?? DEFAULT_TEMPLATE;
      return current.title === preset.templates[type].title && current.body === preset.templates[type].body;
    }),
  );
}
