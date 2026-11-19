import { describe, expect, test } from "bun:test";
import { appSettingsSchema, getSettings, updateSettings } from "../src/server/settings";
import { patchSchema } from "../src/server/routes/util";

describe("settings", () => {
  test("defaults", () => {
    expect(getSettings().agentUpdateCheckMinutes).toBe(15);
    expect(getSettings().time.timezone).toBeNull();
  });

  test("patch keeps fields that were not sent", () => {
    updateSettings({ alertGraceSec: 30 });
    const patch = patchSchema(appSettingsSchema).parse({ flapWindowSec: 60 });
    const next = updateSettings(patch);
    expect(next.alertGraceSec).toBe(30);
    expect(next.flapWindowSec).toBe(60);
  });

  test("rejects unknown timezones", () => {
    const time = { timezone: "Mars/Base", timeFormat: "auto", timeStyle: "relative" } as const;
    expect(() => updateSettings({ time })).toThrow();
  });
});
