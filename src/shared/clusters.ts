import { z } from "zod";
import {
  CHECK_ID_RE,
  checkParamsSchema,
  IFACE_RE,
  isIPv6,
  NAME_RE,
  VRRP_PASS_RE,
  virtualIpSchema,
} from "./keepalived";

/** Input for creating or editing a VIP (VRRP instance) of a cluster. Shared by the API and the editor. */
export const memberInputSchema = z.object({
  nodeId: z.string().min(1).max(64),
  priority: z.number().int().min(1).max(254),
  interface: z.string().regex(IFACE_RE, "Invalid interface name").nullable().default(null),
  initialState: z.enum(["MASTER", "BACKUP"]).default("BACKUP"),
});
export type MemberInput = z.infer<typeof memberInputSchema>;

export const instanceInputSchema = z.object({
  name: z.string().regex(NAME_RE, "Use letters, digits, _ . - (at most 32)"),
  vrid: z.number().int().min(1).max(255),
  vrrpVersion: z.union([z.literal(2), z.literal(3)]).default(3),
  interface: z.string().regex(IFACE_RE, "Invalid interface name"),
  advertInt: z.number().int().min(1).max(255).default(1),
  preempt: z.boolean().default(true),
  preemptDelay: z.number().int().min(0).max(1000).default(0),
  unicast: z.boolean().default(true),
  /** A new password, null to remove it, left out to keep the current one. */
  authPass: z
    .string()
    .regex(VRRP_PASS_RE, "1 to 8 characters, no spaces, quotes, braces, # or !")
    .nullable()
    .optional(),
  virtualIps: z.array(virtualIpSchema).min(1).max(20),
  members: z.array(memberInputSchema).min(1).max(16),
  checkIds: z.array(z.string().max(64)).max(16).default([]),
});
export type InstanceInput = z.infer<typeof instanceInputSchema>;

/** Rules across fields of one VIP. Returns readable problems, empty when it is fine. */
export function instanceInputProblems(input: InstanceInput, hasPassword = false): string[] {
  const problems: string[] = [];
  const v6 = input.virtualIps.filter((v) => isIPv6(v.address)).length;
  if (v6 && input.vrrpVersion !== 3) problems.push("IPv6 addresses need VRRP version 3");
  if (v6 && v6 !== input.virtualIps.length) problems.push("Do not mix IPv4 and IPv6 addresses");
  for (const vip of input.virtualIps) {
    if (vip.prefix > (isIPv6(vip.address) ? 128 : 32)) problems.push(`Prefix too long for ${vip.address}`);
  }
  const addresses = input.virtualIps.map((v) => v.address);
  if (new Set(addresses).size !== addresses.length) problems.push("Each address can only be listed once");
  const willHavePassword = input.authPass === undefined ? hasPassword : !!input.authPass;
  if (willHavePassword && input.vrrpVersion !== 2) problems.push("Passwords only exist in VRRP version 2");
  const nodes = input.members.map((m) => m.nodeId);
  if (new Set(nodes).size !== nodes.length) problems.push("Each node can only be a member once");
  const priorities = input.members.map((m) => m.priority);
  if (new Set(priorities).size !== priorities.length) problems.push("Give each member a different priority");
  if (!input.preempt && input.members.some((m) => m.initialState === "MASTER")) {
    problems.push("Without preempt every member must start as BACKUP");
  }
  if (input.members.filter((m) => m.initialState === "MASTER").length > 1) {
    problems.push("Only one member can start as MASTER");
  }
  return problems;
}

export const checkInputSchema = z.object({
  name: z.string().trim().min(1).max(64),
  key: z.string().regex(CHECK_ID_RE, "Lowercase letters, digits and _ (at most 32)"),
  params: checkParamsSchema,
  intervalSec: z.number().int().min(1).max(3600).default(2),
  timeoutSec: z.number().int().min(1).max(60).default(2),
  fall: z.number().int().min(1).max(10).default(2),
  rise: z.number().int().min(1).max(10).default(2),
  weight: z.number().int().min(-254).max(254).default(0),
});
export type CheckInput = z.infer<typeof checkInputSchema>;

export const clusterInputSchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(300).nullable().default(null),
});
