import { describe, expect, test } from "bun:test";
import { instanceSpecSchema, keepalivedSpecSchema, specProblems, type KeepalivedSpec } from "../src/shared/keepalived";

const instance = {
  name: "VI_web",
  vrid: 51,
  vrrpVersion: 3,
  interface: "eth0",
  state: "BACKUP",
  priority: 100,
  advertInt: 1,
  preempt: true,
  virtualIps: [{ address: "10.0.0.10", prefix: 24 }],
};

function spec(over: Record<string, unknown> = {}, extra: Partial<KeepalivedSpec> = {}): KeepalivedSpec {
  return keepalivedSpecSchema.parse({ version: 1, instances: [{ ...instance, ...over }], ...extra });
}

describe("keepalived spec", () => {
  test("accepts a plain instance", () => {
    expect(specProblems(spec())).toEqual([]);
  });

  test("rejects values that could add config directives", () => {
    for (const bad of ["VI web", "VI}\nglobal_defs{", 'VI"', "", "a".repeat(33)]) {
      expect(instanceSpecSchema.safeParse({ ...instance, name: bad }).success).toBe(false);
    }
    expect(instanceSpecSchema.safeParse({ ...instance, interface: "eth0\n}" }).success).toBe(false);
    const vip = { address: "10.0.0.1\nvirtual_server", prefix: 24 };
    expect(instanceSpecSchema.safeParse({ ...instance, virtualIps: [vip] }).success).toBe(false);
  });

  test("keeps script checks in the scripts directory", () => {
    const check = (path: string) => ({ id: "c1", params: { type: "script", path } });
    const outside = { version: 1, instances: [], checks: [check("/tmp/x.sh")] };
    expect(keepalivedSpecSchema.safeParse(outside).success).toBe(false);
    const escape = check("/etc/keepwatch/scripts/../../bin/sh");
    expect(keepalivedSpecSchema.safeParse({ version: 1, instances: [], checks: [escape] }).success).toBe(false);
    const ok = check("/etc/keepwatch/scripts/db.sh");
    expect(keepalivedSpecSchema.safeParse({ version: 1, instances: [], checks: [ok] }).success).toBe(true);
  });

  test("cross-field rules", () => {
    expect(specProblems(spec({ vrrpVersion: 2, virtualIps: [{ address: "fd00::1", prefix: 64 }] }))).toContain(
      "VI_web: IPv6 addresses need VRRP version 3",
    );
    expect(specProblems(spec({ preempt: false, state: "MASTER" }))).toContain(
      "VI_web: no preempt needs the BACKUP state",
    );
    expect(specProblems(spec({ checks: ["missing"] }))).toContain("VI_web: unknown check missing");
    const twice = keepalivedSpecSchema.parse({ version: 1, instances: [instance, { ...instance, name: "VI_two" }] });
    expect(specProblems(twice)).toContain("VRID 51 is used twice on eth0");
  });
});

describe("check presets", () => {
  test("every preset is a valid check", async () => {
    const { CHECK_PRESETS } = await import("../src/shared/check-presets");
    const { checkInputSchema } = await import("../src/shared/clusters");
    for (const p of CHECK_PRESETS) {
      const parsed = checkInputSchema.safeParse({ name: p.name, key: p.key, params: p.params, weight: p.weight });
      expect(parsed.success).toBe(true);
    }
  });
});
