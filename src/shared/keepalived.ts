import { z } from "zod";

/**
 * keepalived spec sent to the agent with ka_plan and ka_apply. The agent renders the config itself and checks every
 * value again, so nothing here can add a directive. Keep in sync with agent/internal/keepalived/spec.go.
 */
export const SPEC_VERSION = 1;

/** Instance, process and check names. They end up in the config as bare words. */
export const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/;
/** Linux interface names, at most 15 characters. */
export const IFACE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:@-]{0,14}$/;
/** Process names for track_process. */
export const PROCESS_RE = /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,63}$/;
export const CHECK_ID_RE = /^[a-z0-9_]{1,32}$/;
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
export const HOSTNAME_RE = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);
/** Custom check scripts must live here, owned by root and not writable by others. */
export const SCRIPT_DIR = "/etc/keepwatch/scripts/";
export const SCRIPT_RE = /^\/etc\/keepwatch\/scripts\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
/** VRRPv2 simple passwords are at most 8 characters. */
export const VRRP_PASS_MAX = 8;

export const ip = z.union([z.ipv4(), z.ipv6()]);
const host = z.union([z.ipv4(), z.ipv6(), z.string().regex(HOSTNAME_RE, "Invalid host name")]);
const name = z.string().regex(NAME_RE, "Use letters, digits, _ . - (at most 32)");
const iface = z.string().regex(IFACE_RE, "Invalid interface name");

export const isIPv6 = (value: string) => value.includes(":");

export const virtualIpSchema = z.object({
  address: ip,
  prefix: z.number().int().min(0).max(128),
  /** Interface to add the VIP to, the instance interface when empty. */
  dev: iface.optional(),
});
export type VirtualIp = z.infer<typeof virtualIpSchema>;

export const CHECK_TYPES = ["tcp", "http", "ping", "process", "script"] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

export const CHECK_TYPE_LABELS: Record<CheckType, string> = {
  tcp: "TCP port",
  http: "HTTP(S)",
  ping: "Ping",
  process: "Process",
  script: "Custom script",
};

export const checkParamsSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tcp"), host, port: z.number().int().min(1).max(65535) }),
  z.object({
    type: z.literal("http"),
    url: z
      .url({ protocol: /^https?$/ })
      .max(300)
      .refine((v) => !/[\s"'\\]/.test(v), "URL must not contain spaces, quotes or backslashes"),
    expectStatus: z.number().int().min(100).max(599).default(200),
    insecureTls: z.boolean().default(false),
  }),
  z.object({ type: z.literal("ping"), host }),
  z.object({ type: z.literal("process"), process: z.string().regex(PROCESS_RE, "Invalid process name") }),
  z.object({
    type: z.literal("script"),
    path: z
      .string()
      .regex(SCRIPT_RE, `Scripts must be in ${SCRIPT_DIR}`)
      .refine((v) => !v.includes(".."), "Invalid path"),
  }),
]);
export type CheckParams = z.infer<typeof checkParamsSchema>;

export const checkSpecSchema = z.object({
  id: z.string().regex(CHECK_ID_RE),
  params: checkParamsSchema,
  intervalSec: z.number().int().min(1).max(3600).default(2),
  timeoutSec: z.number().int().min(1).max(60).default(2),
  fall: z.number().int().min(1).max(10).default(2),
  rise: z.number().int().min(1).max(10).default(2),
  /** Added to the priority while the check fails. 0 puts the instance in FAULT instead. */
  weight: z.number().int().min(-254).max(254).default(0),
});
export type CheckSpec = z.infer<typeof checkSpecSchema>;

export const instanceSpecSchema = z.object({
  name,
  vrid: z.number().int().min(1).max(255),
  vrrpVersion: z.union([z.literal(2), z.literal(3)]),
  interface: iface,
  state: z.enum(["MASTER", "BACKUP"]),
  priority: z.number().int().min(1).max(254),
  advertInt: z.number().int().min(1).max(255),
  preempt: z.boolean(),
  preemptDelay: z.number().int().min(0).max(1000).default(0),
  unicastSrcIp: ip.optional(),
  unicastPeers: z.array(ip).max(16).default([]),
  virtualIps: z.array(virtualIpSchema).min(1).max(20),
  /** Sealed VRRPv2 password, see crypto/sealing. */
  authPass: z.string().startsWith("s1:").max(300).optional(),
  trackInterfaces: z
    .array(z.object({ name: iface, weight: z.number().int().min(-254).max(254) }))
    .max(8)
    .default([]),
  checks: z.array(z.string().regex(CHECK_ID_RE)).max(16).default([]),
});
export type InstanceSpec = z.infer<typeof instanceSpecSchema>;

export const keepalivedSpecSchema = z.object({
  version: z.literal(SPEC_VERSION),
  instances: z.array(instanceSpecSchema).max(64),
  checks: z.array(checkSpecSchema).max(64).default([]),
});
export type KeepalivedSpec = z.infer<typeof keepalivedSpecSchema>;

/** Rules that need more than one field. Returns readable problems, empty when the spec is fine. */
export function specProblems(spec: KeepalivedSpec): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  const vrids = new Set<string>();
  const checkIds = new Set(spec.checks.map((c) => c.id));
  if (checkIds.size !== spec.checks.length) problems.push("Check ids must be unique");
  for (const inst of spec.instances) {
    if (names.has(inst.name)) problems.push(`Instance name ${inst.name} is used twice`);
    names.add(inst.name);
    const key = `${inst.interface}/${inst.vrid}/${inst.virtualIps.some((v) => isIPv6(v.address)) ? 6 : 4}`;
    if (vrids.has(key)) problems.push(`VRID ${inst.vrid} is used twice on ${inst.interface}`);
    vrids.add(key);
    const v6 = inst.virtualIps.filter((v) => isIPv6(v.address)).length;
    if (v6 && inst.vrrpVersion !== 3) problems.push(`${inst.name}: IPv6 addresses need VRRP version 3`);
    if (v6 && v6 !== inst.virtualIps.length) problems.push(`${inst.name}: do not mix IPv4 and IPv6 addresses`);
    for (const vip of inst.virtualIps) {
      const max = isIPv6(vip.address) ? 128 : 32;
      if (vip.prefix > max) problems.push(`${inst.name}: prefix too long for ${vip.address}`);
    }
    if (inst.authPass && inst.vrrpVersion !== 2) problems.push(`${inst.name}: passwords only exist in VRRP version 2`);
    if (!inst.preempt && inst.state !== "BACKUP") problems.push(`${inst.name}: no preempt needs the BACKUP state`);
    if (inst.unicastSrcIp && inst.unicastPeers.includes(inst.unicastSrcIp)) {
      problems.push(`${inst.name}: the source address cannot be its own peer`);
    }
    for (const id of inst.checks) {
      if (!checkIds.has(id)) problems.push(`${inst.name}: unknown check ${id}`);
    }
  }
  return problems;
}

// Status reported by the agent

export const VRRP_STATES = ["MASTER", "BACKUP", "FAULT", "STOP", "UNKNOWN"] as const;
export type VrrpState = (typeof VRRP_STATES)[number];

export const instanceStatusSchema = z.object({
  name: z.string().max(64),
  state: z.enum(VRRP_STATES),
  priority: z.number().int().min(0).max(255).nullable().optional(),
  since: z.number().nullable().optional(),
  maintenance: z.boolean().default(false),
});
export type InstanceStatus = z.infer<typeof instanceStatusSchema>;

export const kaStatusSchema = z.object({
  installed: z.boolean(),
  version: z.string().max(64).nullable(),
  /** systemctl is-active for keepalived. */
  service: z.string().max(32),
  enabled: z.boolean(),
  /** Whether the managed include is in place. */
  managed: z.boolean(),
  configHash: z.string().max(128).nullable(),
  drift: z.boolean(),
  /** Why the agent cannot manage the config, for example a notify FIFO already set by the user. */
  conflict: z.string().max(300).nullable().optional(),
  instances: z.array(instanceStatusSchema).max(128),
  /** Addresses on the node's interfaces. */
  addresses: z
    .array(z.object({ iface: z.string().max(32), address: z.string().max(64), prefix: z.number().int() }))
    .max(256),
  checks: z
    .array(
      z.object({
        id: z.string().max(32),
        ok: z.boolean(),
        since: z.number().nullable().optional(),
        error: z.string().max(300).optional(),
      }),
    )
    .max(64),
  customScripts: z.boolean().default(false),
});
export type KaStatus = z.infer<typeof kaStatusSchema>;
