// Made-up data for the static demo build and the README screenshots. Nothing here touches a real network.
import { DEFAULT_EVENT_SEVERITY, type EventType } from "./events";
import type { CheckParams, KaStatus, VirtualIp, VrrpState } from "./keepalived";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type DemoCluster = { id: string; name: string; description: string | null };
export type DemoNode = {
  id: string;
  name: string;
  description: string | null;
  clusterId: string | null;
  configMode: "managed" | "monitor" | null;
  ip: string;
  iface: string;
  agentVersion: string;
  keepalivedVersion: string;
  online: boolean;
  drift: boolean;
  behind: boolean;
  failingChecks: { id: string; error: string }[];
  autoUpdate: boolean;
};
export type DemoMember = {
  nodeId: string;
  priority: number;
  interface: string | null;
  initialState: "MASTER" | "BACKUP";
  state: VrrpState;
  maintenance: boolean;
  stateSince: number;
};
export type DemoVip = {
  id: string;
  clusterId: string;
  name: string;
  service: string | null;
  vrid: number;
  vrrpVersion: 2 | 3;
  interface: string;
  advertInt: number;
  preempt: boolean;
  preemptDelay: number;
  unicast: boolean;
  hasPassword: boolean;
  virtualIps: VirtualIp[];
  members: DemoMember[];
  checkIds: string[];
};
export type DemoCheck = {
  id: string;
  clusterId: string;
  name: string;
  key: string;
  params: CheckParams;
  intervalSec: number;
  timeoutSec: number;
  fall: number;
  rise: number;
  weight: number;
};
export type DemoEvent = {
  id: number;
  type: EventType;
  severity: string;
  nodeId: string | null;
  clusterId: string | null;
  instanceId: string | null;
  title: string;
  message: string;
  data: Record<string, unknown>;
  createdAt: number;
};
export type DemoChannel = {
  id: string;
  name: string;
  type: "ntfy" | "discord" | "email" | "telegram";
  enabled: boolean;
  events: EventType[];
  config: Record<string, string | number>;
  secretsSet: Record<string, boolean>;
};
export type DemoDelivery = {
  id: number;
  eventId: number;
  channelId: string;
  status: "success" | "failed";
  error: string | null;
};

export type DemoData = {
  clusters: DemoCluster[];
  nodes: DemoNode[];
  vips: DemoVip[];
  checks: DemoCheck[];
  events: DemoEvent[];
  channels: DemoChannel[];
  deliveries: DemoDelivery[];
};

export const DEMO_USER = { id: "demo-user", name: "Alex Admin", email: "alex@example.com" };

/** Small seeded random, so the demo looks the same on every load. */
function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

export function generateDemoData(now = Date.now()): DemoData {
  const rnd = random(42);
  const clusters: DemoCluster[] = [
    { id: "c-edge", name: "edge", description: "Public load balancers" },
    { id: "c-db", name: "db", description: "PostgreSQL write address" },
    { id: "c-home", name: "homelab", description: null },
  ];
  const node = (n: Partial<DemoNode> & Pick<DemoNode, "id" | "name" | "clusterId" | "ip">): DemoNode => ({
    description: null,
    configMode: "managed",
    iface: "eth0",
    agentVersion: "1.2.0",
    keepalivedVersion: "2.2.8",
    online: true,
    drift: false,
    behind: false,
    failingChecks: [],
    autoUpdate: true,
    ...n,
  });
  const nodes: DemoNode[] = [
    node({ id: "n-lb1", name: "lb1", clusterId: "c-edge", ip: "10.0.0.2", description: "fra1" }),
    node({
      id: "n-lb2",
      name: "lb2",
      clusterId: "c-edge",
      ip: "10.0.0.3",
      description: "fra1",
      failingChecks: [{ id: "https", error: "status 502, expected 200" }],
    }),
    node({ id: "n-lb3", name: "lb3", clusterId: "c-edge", ip: "10.0.0.4", description: "fra2", behind: true }),
    node({ id: "n-pg1", name: "pg1", clusterId: "c-db", ip: "10.20.0.11", iface: "ens18" }),
    node({ id: "n-pg2", name: "pg2", clusterId: "c-db", ip: "10.20.0.12", iface: "ens18", agentVersion: "1.1.4" }),
    node({ id: "n-pve1", name: "pve1", clusterId: "c-home", ip: "192.168.1.11", iface: "vmbr0" }),
    node({ id: "n-pve2", name: "pve2", clusterId: "c-home", ip: "192.168.1.12", iface: "vmbr0", drift: true }),
    node({ id: "n-pve3", name: "pve3", clusterId: "c-home", ip: "192.168.1.13", iface: "vmbr0" }),
    node({
      id: "n-pi",
      name: "pi",
      clusterId: "c-home",
      ip: "192.168.1.20",
      configMode: "monitor",
      keepalivedVersion: "2.2.7",
      online: false,
    }),
  ];
  const since = now - 3 * DAY - 4 * HOUR;
  const member = (nodeId: string, priority: number, state: VrrpState, extra: Partial<DemoMember> = {}): DemoMember => ({
    nodeId,
    priority,
    interface: null,
    initialState: "BACKUP",
    state,
    maintenance: false,
    stateSince: since,
    ...extra,
  });
  const vips: DemoVip[] = [
    {
      id: "v-web",
      clusterId: "c-edge",
      name: "VI_web",
      service: "Website",
      vrid: 51,
      vrrpVersion: 3,
      interface: "eth0",
      advertInt: 1,
      preempt: true,
      preemptDelay: 0,
      unicast: true,
      hasPassword: false,
      virtualIps: [{ address: "203.0.113.10", prefix: 24 }],
      members: [
        member("n-lb1", 150, "MASTER", { initialState: "MASTER" }),
        member("n-lb2", 140, "BACKUP"),
        member("n-lb3", 130, "BACKUP"),
      ],
      checkIds: ["k-nginx", "k-https"],
    },
    {
      id: "v-api",
      clusterId: "c-edge",
      name: "VI_api",
      service: "API",
      vrid: 52,
      vrrpVersion: 3,
      interface: "eth0",
      advertInt: 1,
      preempt: true,
      preemptDelay: 30,
      unicast: true,
      hasPassword: false,
      virtualIps: [{ address: "203.0.113.11", prefix: 24 }],
      members: [member("n-lb2", 150, "MASTER", { stateSince: now - 42 * MINUTE }), member("n-lb1", 140, "BACKUP")],
      checkIds: ["k-nginx"],
    },
    {
      id: "v-pg",
      clusterId: "c-db",
      name: "VI_pg",
      service: "PostgreSQL",
      vrid: 61,
      vrrpVersion: 2,
      interface: "ens18",
      advertInt: 1,
      preempt: false,
      preemptDelay: 0,
      unicast: true,
      hasPassword: true,
      virtualIps: [{ address: "10.20.0.5", prefix: 24 }],
      members: [member("n-pg1", 150, "MASTER"), member("n-pg2", 100, "BACKUP")],
      checkIds: ["k-pg"],
    },
    {
      id: "v-dns",
      clusterId: "c-home",
      name: "VI_adguard",
      service: "AdGuard Home",
      vrid: 10,
      vrrpVersion: 3,
      interface: "vmbr0",
      advertInt: 1,
      preempt: true,
      preemptDelay: 0,
      unicast: false,
      hasPassword: false,
      virtualIps: [{ address: "192.168.1.53", prefix: 24 }],
      members: [
        member("n-pve1", 150, "FAULT", { maintenance: true, stateSince: now - 2 * HOUR }),
        member("n-pve2", 140, "MASTER", { stateSince: now - 2 * HOUR }),
        member("n-pve3", 130, "BACKUP"),
      ],
      checkIds: ["k-adguard", "k-dns"],
    },
  ];
  const checks: DemoCheck[] = [
    {
      id: "k-nginx",
      clusterId: "c-edge",
      name: "nginx running",
      key: "nginx",
      params: { type: "process", process: "nginx" },
      intervalSec: 2,
      timeoutSec: 2,
      fall: 2,
      rise: 2,
      weight: 0,
    },
    {
      id: "k-https",
      clusterId: "c-edge",
      name: "Health endpoint",
      key: "https",
      params: { type: "http", url: "https://127.0.0.1/healthz", expectStatus: 200, insecureTls: true },
      intervalSec: 5,
      timeoutSec: 3,
      fall: 3,
      rise: 2,
      weight: -30,
    },
    {
      id: "k-pg",
      clusterId: "c-db",
      name: "PostgreSQL port",
      key: "pg",
      params: { type: "tcp", host: "127.0.0.1", port: 5432 },
      intervalSec: 2,
      timeoutSec: 2,
      fall: 2,
      rise: 3,
      weight: -60,
    },
  ];
  checks.push(
    {
      id: "k-adguard",
      clusterId: "c-home",
      name: "AdGuard Home running",
      key: "adguard",
      params: { type: "process", process: "AdGuardHome" },
      intervalSec: 2,
      timeoutSec: 2,
      fall: 2,
      rise: 2,
      weight: 0,
    },
    {
      id: "k-dns",
      clusterId: "c-home",
      name: "DNS answers on port 53",
      key: "dns",
      params: { type: "tcp", host: "127.0.0.1", port: 53 },
      intervalSec: 2,
      timeoutSec: 2,
      fall: 2,
      rise: 2,
      weight: 0,
    },
  );
  const channels: DemoChannel[] = [
    {
      id: "ch-phone",
      name: "Phone",
      type: "ntfy",
      enabled: true,
      events: ["failover", "split_brain", "no_master", "master_restored", "keepalived_service_failed", "login"],
      config: { serverUrl: "https://ntfy.sh", topic: "keepwatch-demo", priority: "auto" },
      secretsSet: {},
    },
    {
      id: "ch-ops",
      name: "Ops",
      type: "discord",
      enabled: true,
      events: [
        "failover",
        "split_brain",
        "split_brain_resolved",
        "no_master",
        "instance_fault",
        "check_failed",
        "check_recovered",
        "config_applied",
        "config_failed",
        "agent_updated",
      ],
      config: {},
      secretsSet: { webhookUrl: true },
    },
  ];

  channels.push(
    {
      id: "ch-home",
      name: "Homelab",
      type: "telegram",
      enabled: true,
      events: ["failover", "no_master", "master_restored", "check_failed", "check_recovered", "maintenance_on"],
      config: { chatId: "-1001234567890" },
      secretsSet: { botToken: true },
    },
    {
      id: "ch-mail",
      name: "On-call email",
      type: "email",
      enabled: false,
      events: ["split_brain", "no_master", "keepalived_service_failed", "config_failed", "config_rolled_back"],
      config: { to: "oncall@example.com" },
      secretsSet: { password: true },
    },
  );
  const name = (id: string | null) => nodes.find((n) => n.id === id)?.name ?? "";
  const clusterName = (id: string | null) => clusters.find((c) => c.id === id)?.name ?? "";
  const events: DemoEvent[] = [];
  const add = (type: EventType, at: number, title: string, message: string, extra: Partial<DemoEvent> = {}) => {
    events.push({
      id: 0,
      type,
      severity: DEFAULT_EVENT_SEVERITY[type],
      nodeId: null,
      clusterId: null,
      instanceId: null,
      title,
      message,
      data: {},
      createdAt: at,
      ...extra,
    });
  };
  const reasons = ["is in FAULT", "went offline", "is in maintenance"];
  for (let day = 20; day >= 0; day--) {
    const count = rnd() < 0.55 ? 0 : rnd() < 0.7 ? 1 : 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < count; i++) {
      const vip = vips[Math.floor(rnd() * 3)]!;
      const [from, to] = rnd() < 0.5 ? [vip.members[0]!, vip.members[1]!] : [vip.members[1]!, vip.members[0]!];
      const reason = `${name(from.nodeId)} ${reasons[Math.floor(rnd() * reasons.length)]}`;
      const at = now - day * DAY - Math.floor(rnd() * 20) * HOUR - 30 * MINUTE;
      const address = vip.virtualIps.map((v) => v.address).join(", ");
      add(
        "failover",
        at,
        `${vip.name} moved to ${name(to.nodeId)}`,
        `${vip.name} (${address}) moved from ${name(from.nodeId)} to ${name(to.nodeId)}: ${reason}`,
        {
          nodeId: to.nodeId,
          clusterId: vip.clusterId,
          instanceId: vip.id,
          data: {
            cluster: clusterName(vip.clusterId),
            vip: vip.name,
            address,
            from: name(from.nodeId),
            to: name(to.nodeId),
            reason,
          },
        },
      );
    }
  }
  add("config_applied", now - 6 * DAY, "Config applied to edge", "Applied the keepalived config to 3 nodes of edge", {
    clusterId: "c-edge",
    data: { cluster: "edge", count: 3 },
  });
  add("agent_updated", now - 4 * DAY, "4 agents updated", "Agents on lb1, lb2, lb3 and pg1 updated to v1.2.0", {
    data: { node: "lb1, lb2, lb3, pg1", count: 4, version: "1.2.0" },
  });
  add(
    "maintenance_on",
    now - 2 * HOUR,
    "Maintenance on for VI_adguard on pve1",
    "pve1 gave up VI_adguard (192.168.1.53) for maintenance",
    {
      nodeId: "n-pve1",
      clusterId: "c-home",
      instanceId: "v-dns",
    },
  );
  add(
    "failover",
    now - 2 * HOUR + 3000,
    "VI_adguard moved to pve2",
    "VI_adguard (192.168.1.53) moved from pve1 to pve2: pve1 is in maintenance",
    {
      nodeId: "n-pve2",
      clusterId: "c-home",
      instanceId: "v-dns",
      data: { cluster: "homelab", vip: "VI_adguard", from: "pve1", to: "pve2", reason: "pve1 is in maintenance" },
    },
  );
  add(
    "config_drift",
    now - 90 * MINUTE,
    "pve2: keepwatch.conf was changed outside KeepWatch",
    "pve2: keepwatch.conf was changed outside KeepWatch",
    {
      nodeId: "n-pve2",
      clusterId: "c-home",
    },
  );
  add(
    "check_failed",
    now - 50 * MINUTE,
    "https failing on lb2",
    "Health check https on lb2 failed: status 502, expected 200",
    {
      nodeId: "n-lb2",
      clusterId: "c-edge",
      data: { node: "lb2", check: "https", error: "status 502, expected 200" },
    },
  );
  add(
    "failover",
    now - 42 * MINUTE,
    "VI_api moved to lb2",
    "VI_api (203.0.113.11) moved from lb1 to lb2: a member with a higher priority took over",
    {
      nodeId: "n-lb2",
      clusterId: "c-edge",
      instanceId: "v-api",
    },
  );
  add("agent_disconnected", now - 25 * MINUTE, "pi disconnected", "Agent on pi lost its connection", {
    nodeId: "n-pi",
  });
  add(
    "login",
    now - 5 * MINUTE,
    "New sign-in to KeepWatch",
    "alex@example.com signed in with password and authenticator app from Firefox on Linux (203.0.113.7)",
  );
  events.sort((a, b) => a.createdAt - b.createdAt);
  events.forEach((e, i) => (e.id = i + 1));

  const deliveries: DemoDelivery[] = [];
  for (const e of events) {
    for (const ch of channels) {
      if (!ch.events.includes(e.type)) continue;
      const failed = rnd() < 0.04;
      deliveries.push({
        id: deliveries.length + 1,
        eventId: e.id,
        channelId: ch.id,
        status: failed ? "failed" : "success",
        error: failed ? "HTTP 429: rate limited" : null,
      });
    }
  }
  return { clusters, nodes, vips, checks, events, channels, deliveries };
}

/** The status report a demo node's agent would send. */
export function demoStatus(node: DemoNode, vips: DemoVip[], now: number): KaStatus & { reportedAt: number } {
  const mine = vips.flatMap((v) => v.members.filter((m) => m.nodeId === node.id).map((m) => ({ v, m })));
  return {
    installed: true,
    version: node.keepalivedVersion,
    service: "active",
    enabled: true,
    managed: node.configMode === "managed",
    configHash: "3f05798c1a2b",
    drift: node.drift,
    conflict: null,
    instances: mine.map(({ v, m }) => ({
      name: v.name,
      state: m.state,
      priority: m.priority,
      since: m.stateSince,
      maintenance: m.maintenance,
    })),
    addresses: [
      { iface: node.iface, address: node.ip, prefix: 24 },
      ...mine
        .filter(({ m }) => m.state === "MASTER")
        .flatMap(({ v }) => v.virtualIps.map((a) => ({ iface: node.iface, address: a.address, prefix: a.prefix }))),
    ],
    checks: [...node.failingChecks.map((c) => ({ id: c.id, ok: false, since: now - 50 * MINUTE, error: c.error }))],
    customScripts: false,
    reportedAt: now - 8_000,
  };
}
