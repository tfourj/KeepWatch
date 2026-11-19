import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { agents, checks, instanceChecks, instanceMembers, nodes, vrrpInstances } from "../db/schema";
import { sha256Hex } from "../crypto/secretbox";
import { box } from "../secrets";
import {
  isIPv6,
  keepalivedSpecSchema,
  SPEC_VERSION,
  specProblems,
  type CheckSpec,
  type InstanceSpec,
  type KeepalivedSpec,
} from "../../shared/keepalived";

type AgentInterface = { name: string; mac: string; cidrs: string[] };

/** The node's own address on an interface, in the family of the VIPs. */
export function interfaceAddress(interfaces: AgentInterface[] | null | undefined, iface: string, v6: boolean) {
  const match = interfaces?.find((i) => i.name === iface);
  for (const cidr of match?.cidrs ?? []) {
    const address = cidr.split("/")[0]!;
    if (isIPv6(address) !== v6) continue;
    // Link-local addresses cannot be unicast peers across links.
    if (v6 && address.toLowerCase().startsWith("fe80:")) continue;
    return address;
  }
  return null;
}

export type BuiltSpec = {
  spec: KeepalivedSpec;
  /** Changes with the config, but not with the random sealing of passwords. */
  hash: string;
  problems: string[];
};

/**
 * Builds the keepalived spec for one node from every VIP it is a member of. `seal` encrypts the VRRP password for
 * this node's agent; without it passwords are left out, for hashing and previews.
 */
export function buildNodeSpec(nodeId: string, seal?: (plain: string) => string): BuiltSpec {
  const problems: string[] = [];
  const memberships = db.select().from(instanceMembers).where(eq(instanceMembers.nodeId, nodeId)).all();
  const instanceIds = memberships.map((m) => m.instanceId);
  const instances = instanceIds.length
    ? db.select().from(vrrpInstances).where(inArray(vrrpInstances.id, instanceIds)).all()
    : [];
  const allMembers = instanceIds.length
    ? db.select().from(instanceMembers).where(inArray(instanceMembers.instanceId, instanceIds)).all()
    : [];
  const memberNodeIds = [...new Set(allMembers.map((m) => m.nodeId))];
  const agentRows = memberNodeIds.length
    ? db.select().from(agents).where(inArray(agents.nodeId, memberNodeIds)).all()
    : [];
  const nodeRows = memberNodeIds.length
    ? db.select().from(nodes).where(inArray(nodes.id, memberNodeIds)).all()
    : [];
  const nodeName = (id: string) => nodeRows.find((n) => n.id === id)?.name ?? "node";
  const interfacesOf = (id: string) => agentRows.find((a) => a.nodeId === id)?.interfaces ?? null;

  const links = instanceIds.length
    ? db.select().from(instanceChecks).where(inArray(instanceChecks.instanceId, instanceIds)).all()
    : [];
  const checkIds = [...new Set(links.map((l) => l.checkId))];
  const checkRows = checkIds.length ? db.select().from(checks).where(inArray(checks.id, checkIds)).all() : [];
  const checkSpecs: CheckSpec[] = checkRows
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((c) => ({
      id: c.key,
      params: c.params,
      intervalSec: c.intervalSec,
      timeoutSec: c.timeoutSec,
      fall: c.fall,
      rise: c.rise,
      weight: c.weight,
    }));

  const hashParts: unknown[] = [];
  const instanceSpecs: InstanceSpec[] = [];
  for (const inst of instances.sort((a, b) => a.name.localeCompare(b.name))) {
    const me = memberships.find((m) => m.instanceId === inst.id)!;
    const iface = me.interface ?? inst.interface;
    const v6 = inst.virtualIps.some((v) => isIPv6(v.address));
    const spec: InstanceSpec = {
      name: inst.name,
      vrid: inst.vrid,
      vrrpVersion: inst.vrrpVersion as 2 | 3,
      interface: iface,
      state: me.initialState,
      priority: me.priority,
      advertInt: inst.advertInt,
      preempt: inst.preempt,
      preemptDelay: inst.preemptDelay,
      unicastPeers: [],
      virtualIps: inst.virtualIps,
      trackInterfaces: [],
      checks: links
        .filter((l) => l.instanceId === inst.id)
        .map((l) => checkRows.find((c) => c.id === l.checkId)!.key)
        .sort(),
    };
    if (inst.unicast) {
      const src = interfaceAddress(interfacesOf(nodeId), iface, v6);
      if (!src) problems.push(`${inst.name}: no ${v6 ? "IPv6" : "IPv4"} address on ${iface} of ${nodeName(nodeId)}`);
      else spec.unicastSrcIp = src;
      for (const peer of allMembers.filter((m) => m.instanceId === inst.id && m.nodeId !== nodeId)) {
        const peerIface = peer.interface ?? inst.interface;
        const address = interfaceAddress(interfacesOf(peer.nodeId), peerIface, v6);
        if (!address) problems.push(`${inst.name}: no address on ${peerIface} of ${nodeName(peer.nodeId)}`);
        else spec.unicastPeers.push(address);
      }
      spec.unicastPeers.sort();
    }
    let passHash: string | null = null;
    if (inst.authPassEnc) {
      const plain = box.decrypt(inst.authPassEnc);
      passHash = sha256Hex(plain);
      if (seal) spec.authPass = seal(plain);
    }
    hashParts.push({ ...spec, authPass: passHash });
    instanceSpecs.push(spec);
  }

  const spec = keepalivedSpecSchema.parse({ version: SPEC_VERSION, instances: instanceSpecs, checks: checkSpecs });
  problems.push(...specProblems(spec));
  return { spec, hash: sha256Hex(JSON.stringify({ instances: hashParts, checks: checkSpecs })), problems };
}

/** Nodes that are members of at least one VIP of the cluster. */
export function clusterMemberNodeIds(clusterId: string): string[] {
  const rows = db
    .select({ nodeId: instanceMembers.nodeId })
    .from(instanceMembers)
    .innerJoin(vrrpInstances, eq(vrrpInstances.id, instanceMembers.instanceId))
    .where(and(eq(vrrpInstances.clusterId, clusterId)))
    .all();
  return [...new Set(rows.map((r) => r.nodeId))];
}
