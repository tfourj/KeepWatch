import { describe, expect, test } from "bun:test";
import { templateVars } from "../src/server/notify/templates";
import { EVENT_TYPES, TEMPLATE_VARIABLES, type EventType } from "../src/shared/events";
import { matchTemplatePreset, TEMPLATE_PRESETS } from "../src/shared/template-presets";
import {
  previewTemplate,
  renderMessage,
  renderTemplate,
  resolveTemplate,
  sampleTemplateVars,
} from "../src/shared/templates";

describe("templates", () => {
  test("replaces known variables and keeps unknown ones", () => {
    expect(renderTemplate("{vip} on {node} ({nope})", { vip: "VI_web", node: "lb1" })).toBe("VI_web on lb1 ({nope})");
  });

  test("leaves out lines whose values are all empty", () => {
    const vars = { message: "M", reason: "", check: "", vip: "VI_web" };
    expect(renderTemplate("{message}\n\nReason {reason}\nCheck {check}", vars)).toBe("M");
    expect(renderTemplate("{vip} by {reason}\nno values\n{nope}", vars)).toBe("VI_web by \nno values\n{nope}");
  });

  test("an empty title or body falls back to the event's own", () => {
    const vars = { title: "T", message: "M", reason: "" };
    expect(renderMessage({ title: "", body: "Reason {reason}" }, vars)).toEqual({ title: "T", body: "M" });
    expect(renderMessage({ title: "x", body: "y" }, vars)).toEqual({ title: "x", body: "y" });
  });

  test("counts only for grouped events", () => {
    const event = { type: "agent_updated", title: "T", message: "M", createdAt: new Date("2026-01-01T00:00:00Z") };
    expect(templateVars({ ...event, data: { node: "lb1, lb2", count: 2 } })).toMatchObject({
      node: "lb1, lb2",
      count: "2",
    });
    expect(templateVars({ ...event, data: { node: "lb1" } }).count).toBe("");
  });

  test("builds every variable from event data", () => {
    const vars = templateVars({
      type: "failover",
      title: "T",
      message: "M",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      data: { cluster: "edge", vip: "VI_web", from: "lb1", to: "lb2", priority: 150, nodes: ["a"] },
    });
    expect(vars).toMatchObject({ cluster: "edge", vip: "VI_web", from: "lb1", to: "lb2", priority: "150" });
    expect(Object.keys(vars).sort()).toEqual([...TEMPLATE_VARIABLES].sort());
    expect(vars.time).toContain("2026");
  });

  test("channel overrides win over global templates, which win over the default", () => {
    const global = { failover: { title: "G {vip}", body: "GB" } };
    expect(resolveTemplate("failover", global, {})).toEqual({ title: "G {vip}", body: "GB" });
    expect(resolveTemplate("failover", global, { titleTemplate: "C" })).toEqual({ title: "C", body: "GB" });
    expect(resolveTemplate("other", global, { bodyTemplate: "  " })).toEqual({ title: "{title}", body: "{message}" });
  });
});

describe("template previews", () => {
  const now = new Date("2026-01-01T12:00:00Z");

  test("every event type has sample variables for each template variable", () => {
    for (const type of EVENT_TYPES) {
      const vars = sampleTemplateVars(type, now);
      expect(Object.keys(vars).sort()).toEqual([...TEMPLATE_VARIABLES].sort());
      expect(vars.event).toBe(type);
      expect(vars.title).not.toBe("");
      expect(vars.message).not.toBe("");
    }
  });

  test("renders a template with the sample event", () => {
    const preview = previewTemplate("failover", { title: "{title}", body: "{vip} on {to} {nope}" }, now);
    expect(preview).toEqual({ title: "VI_web moved to lb2", body: "VI_web on lb2 {nope}" });
  });
});

describe("template presets", () => {
  const variable = new RegExp(`\\{(?!(?:${TEMPLATE_VARIABLES.join("|")})\\})[a-z_]+\\}`, "i");

  test("every preset covers each event type with known variables", () => {
    for (const preset of TEMPLATE_PRESETS) {
      expect(Object.keys(preset.templates).sort()).toEqual([...EVENT_TYPES].sort());
      for (const template of Object.values(preset.templates)) {
        expect(template.title).not.toBe("");
        expect(template.body).not.toBe("");
        expect(`${template.title} ${template.body}`).not.toMatch(variable);
      }
    }
  });

  test("preset ids are unique and each preset matches only itself", () => {
    expect(new Set(TEMPLATE_PRESETS.map((p) => p.id)).size).toBe(TEMPLATE_PRESETS.length);
    for (const preset of TEMPLATE_PRESETS) expect(matchTemplatePreset(preset.templates)?.id).toBe(preset.id);
  });

  test("no saved templates match the default preset and edits match none", () => {
    expect(matchTemplatePreset({})?.id).toBe("default");
    expect(matchTemplatePreset({ login: { title: "Sign-in", body: "{message}" } })).toBeUndefined();
  });

  const now = new Date("2026-01-01T12:00:00Z");
  const preview = (id: string, type: EventType) =>
    previewTemplate(type, TEMPLATE_PRESETS.find((p) => p.id === id)!.templates[type], now);

  test("icon presets write the message themselves with icons", () => {
    expect(preview("icon-default", "failover")).toEqual({
      title: "🔀 VI_web moved to lb2",
      body: "VI_web moved to lb2\n🌐 10.0.0.10\n⬅️ From lb1\n💬 lb1 is in FAULT",
    });
    expect(preview("icon-minimal", "instance_fault").body).toBe("🌐 10.0.0.10\n⬅️ MASTER");
    expect(preview("minimal", "config_failed").body).toBe("keepalived rejected the config");
  });

  test("presets leave out values an event does not carry", () => {
    const check = preview("icon-detailed", "check_failed").body;
    expect(check).toMatch(/^web is failing on lb1\n❗ connection refused\n🗂️ Cluster edge\n🕒 /);
    expect(preview("minimal", "login").body).toBe(sampleTemplateVars("login", now).message);
  });

  test("every preset renders a title and body for each example event", () => {
    for (const preset of TEMPLATE_PRESETS) {
      for (const type of EVENT_TYPES) {
        const { title, body } = preview(preset.id, type);
        expect(title).not.toBe("");
        expect(body).not.toMatch(/^$|\n$|\{/);
      }
    }
  });
});
