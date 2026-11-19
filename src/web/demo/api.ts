// In-browser stand-in for the KeepWatch API, used only by the static demo build (`bun run build:demo`).
// State lives in memory and resets on reload. Anything that needs a real node or sends a real notification
// answers with a "not available in the demo" error instead.
import { DEFAULT_EVENT_SEVERITY, type EventType } from "@shared/events";
import { instanceInputProblems, instanceInputSchema, checkInputSchema, clusterInputSchema } from "@shared/clusters";
import { demoStatus, generateDemoData, type DemoMember, type DemoNode, type DemoVip } from "@shared/demo-data";
import { LogBuffer } from "@shared/log-buffer";
import { DEFAULT_TIME_PREFERENCES } from "@shared/time";
import { ApiError } from "@/lib/api";

type Body = Record<string, any>;
type Handler = (params: string[], url: URL, body: Body) => unknown;

const NOT_IN_DEMO = "Not available in the demo";
let latencyMs = 120;

/** Tests turn the fake network delay off. */
export function setDemoLatency(ms: number) {
  latencyMs = ms;
}

const startedAt = Date.now();
const state = generateDemoData(startedAt);
let settings = {
  agentUpdateCheckMinutes: 15,
  alertGraceSec: 10,
  flapWindowSec: 120,
  eventRetentionDays: 90,
  historyRetentionDays: 90,
  time: DEFAULT_TIME_PREFERENCES,
  templates: {} as Record<string, { title: string; body: string }>,
};
const masterSince = new Map<string, number>();
const rollouts = new Map<string, { clusterId: string; startedAt: number; nodeIds: string[] }>();
const logs = new LogBuffer(500);
logs.push({ time: new Date(startedAt).toISOString(), level: "info", scope: "server", msg: "listening", fields: {} });

const fail = (message: string, status = 400): never => {
  throw new ApiError(message, status);
};
const id = () => Math.random().toString(36).slice(2, 10);
const nodeName = (nodeId: string | null) => state.nodes.find((n) => n.id === nodeId)?.name ?? "";
const clusterName = (clusterId: string | null) => state.clusters.find((c) => c.id === clusterId)?.name ?? "";
const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

function emit(type: EventType, title: string, message: string, extra: Partial<(typeof state.events)[number]> = {}) {
  state.events.push({
    id: state.events.length + 1,
    type,
    severity: DEFAULT_EVENT_SEVERITY[type],
    nodeId: null,
    clusterId: null,
    instanceId: null,
    title,
    message,
    data: {},
    createdAt: Date.now(),
    ...extra,
  });
  logs.push({ time: new Date().toISOString(), level: "info", scope: "events", msg: message, fields: { event: type } });
}

function master(vip: DemoVip) {
  return vip.members.find((m) => m.state === "MASTER") ?? null;
}

/** keepalived's election in miniature: the highest priority member that is up and not in maintenance wins. */
function elect(vip: DemoVip, reason: string) {
  const before = master(vip);
  const eligible = vip.members.filter((m) => !m.maintenance && nodeOnline(m.nodeId));
  const keep = !vip.preempt && before && eligible.includes(before) ? before : null;
  const winner = keep ?? [...eligible].sort((a, b) => b.priority - a.priority)[0] ?? null;
  for (const m of vip.members) {
    const next = m.maintenance ? "FAULT" : m === winner ? "MASTER" : nodeOnline(m.nodeId) ? "BACKUP" : m.state;
    if (next !== m.state) m.stateSince = Date.now();
    m.state = next;
  }
  if (winner && before && winner !== before) {
    const address = vip.virtualIps.map((v) => v.address).join(", ");
    const from = nodeName(before.nodeId);
    const to = nodeName(winner.nodeId);
    emit("failover", `${vip.name} moved to ${to}`, `${vip.name} (${address}) moved from ${from} to ${to}: ${reason}`, {
      nodeId: winner.nodeId,
      clusterId: vip.clusterId,
      instanceId: vip.id,
      data: { cluster: clusterName(vip.clusterId), vip: vip.name, address, from, to, reason },
    });
  }
  if (winner && winner !== before) masterSince.set(vip.id, Date.now());
}

function nodeOnline(nodeId: string) {
  return state.nodes.find((n) => n.id === nodeId)?.online ?? false;
}

// Serializers that give the same shapes as the real API

function serializeVip(v: DemoVip) {
  const m = master(v);
  return {
    ...v,
    masterNodeId: m?.nodeId ?? null,
    masterSince: iso(masterSince.get(v.id) ?? m?.stateSince),
    splitBrainSince: null,
    splitBrainNotified: false,
    noMasterSince: m ? null : iso(Date.now()),
    noMasterNotified: !m,
    members: v.members
      .map((x) => ({
        instanceId: v.id,
        ...x,
        stateSince: iso(x.stateSince),
        reportedPriority: x.priority,
        holdsVips: x.state === "MASTER",
        reportedAt: iso(Date.now() - 8_000),
      }))
      .sort((a, b) => b.priority - a.priority),
  };
}

function serializeCluster(c: (typeof state.clusters)[number]) {
  return {
    ...c,
    instances: state.vips.filter((v) => v.clusterId === c.id).map(serializeVip),
    checks: state.checks.filter((k) => k.clusterId === c.id),
    nodeIds: state.nodes.filter((n) => n.clusterId === c.id).map((n) => n.id),
  };
}

function serializeNode(n: DemoNode) {
  const now = Date.now();
  const members = state.vips.flatMap((v) =>
    v.members
      .filter((m) => m.nodeId === n.id)
      .map((m) => ({
        instanceId: v.id,
        name: v.name,
        service: v.service,
        priority: m.priority,
        state: m.state,
        maintenance: m.maintenance,
        stateSince: iso(m.stateSince),
      })),
  );
  return {
    id: n.id,
    name: n.name,
    description: n.description,
    clusterId: n.clusterId,
    cluster: n.clusterId ? { id: n.clusterId, name: clusterName(n.clusterId) } : null,
    configMode: n.configMode,
    online: n.online,
    lastSeenAt: iso(n.online ? now - 8_000 : now - 25 * 60_000),
    status: { ...demoStatus(n, state.vips, now), reportedAt: n.online ? now - 8_000 : now - 25 * 60_000 },
    problems: n.failingChecks.map((c) => `check:${c.id}`).concat(n.drift ? ["drift"] : []),
    migrateInstances: null,
    appliedSpecHash: "h",
    appliedAt: iso(now - 6 * 86_400_000),
    agent: {
      id: `a-${n.id}`,
      nodeId: n.id,
      version: n.agentVersion,
      os: "linux",
      arch: n.name === "pi" ? "arm" : "amd64",
      hostname: n.name,
      interfaces: [{ name: n.iface, mac: "52:54:00:12:34:56", cidrs: [`${n.ip}/24`] }],
      connected: n.online,
      lastSeenAt: iso(now - 8_000),
      enrolledAt: iso(now - 30 * 86_400_000),
      autoUpdate: n.autoUpdate,
      updateStatus: null,
      latestVersion: "1.2.0",
      lastUpdateError: null,
      updateAvailable: n.agentVersion !== "1.2.0",
      keyFingerprint: "q3v9XkT2bW8z",
    },
    interfaces: [{ name: n.iface, mac: "52:54:00:12:34:56", cidrs: [`${n.ip}/24`] }],
    members,
    behind: n.behind,
    createdAt: iso(now - 30 * 86_400_000),
  };
}

function serializeEvent(e: (typeof state.events)[number]) {
  return {
    ...e,
    createdAt: iso(e.createdAt),
    nodeName: nodeName(e.nodeId) || null,
    clusterName: clusterName(e.clusterId) || null,
    deliveries: state.deliveries
      .filter((d) => d.eventId === e.id)
      .map((d) => {
        const ch = state.channels.find((c) => c.id === d.channelId)!;
        return {
          id: d.id,
          channelId: ch.id,
          channelName: ch.name,
          channelType: ch.type,
          status: d.status,
          attempts: d.status === "failed" ? 6 : 1,
          lastError: d.error,
          deliveredAt: d.status === "success" ? iso(e.createdAt + 900) : null,
          nextAttemptAt: null,
        };
      }),
  };
}

function serializeChannel(c: (typeof state.channels)[number]) {
  return { ...c, clusterIds: null, nodeIds: null, titleTemplate: null, bodyTemplate: null };
}

function findVip(clusterId: string, vipId: string) {
  return state.vips.find((v) => v.id === vipId && v.clusterId === clusterId) ?? fail("not found", 404);
}

function saveVip(clusterId: string, body: Body, existing?: DemoVip) {
  const parsed = instanceInputSchema.safeParse(body);
  if (!parsed.success) fail(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data!;
  const problems = instanceInputProblems(input, existing?.hasPassword ?? false);
  const others = state.vips.filter((v) => v.clusterId === clusterId && v !== existing);
  if (others.some((v) => v.vrid === input.vrid && v.interface === input.interface)) {
    problems.push(`VRID ${input.vrid} is already used on ${input.interface}`);
  }
  if (problems.length) fail(problems.join("; "));
  const members: DemoMember[] = input.members.map((m) => {
    const old = existing?.members.find((x) => x.nodeId === m.nodeId);
    return {
      nodeId: m.nodeId,
      priority: m.priority,
      interface: m.interface,
      initialState: m.initialState,
      state: old?.state ?? "BACKUP",
      maintenance: old?.maintenance ?? false,
      stateSince: old?.stateSince ?? Date.now(),
    };
  });
  const vip: DemoVip = {
    id: existing?.id ?? `v-${id()}`,
    clusterId,
    name: input.name,
    service: input.service,
    vrid: input.vrid,
    vrrpVersion: input.vrrpVersion,
    interface: input.interface,
    advertInt: input.advertInt,
    preempt: input.preempt,
    preemptDelay: input.preemptDelay,
    unicast: input.unicast,
    hasPassword: input.authPass === undefined ? (existing?.hasPassword ?? false) : !!input.authPass,
    virtualIps: input.virtualIps,
    members,
    checkIds: input.checkIds,
  };
  if (existing) Object.assign(existing, vip);
  else state.vips.push(vip);
  for (const n of state.nodes) if (members.some((m) => m.nodeId === n.id)) n.behind = true;
  return { instance: serializeVip(existing ?? vip) };
}

/** The config the demo would write, close enough to the agent's real output. */
function renderConfig(node: DemoNode) {
  const lines = ["# Managed by KeepWatch. Changes here are overwritten on the next apply.", ""];
  for (const v of state.vips) {
    const m = v.members.find((x) => x.nodeId === node.id);
    if (!m) continue;
    lines.push(
      `vrrp_instance ${v.name} {`,
      `    state ${m.initialState}`,
      `    interface ${m.interface ?? v.interface}`,
    );
    lines.push(`    virtual_router_id ${v.vrid}`, `    priority ${m.priority}`, `    advert_int ${v.advertInt}`);
    lines.push(`    version ${v.vrrpVersion}`);
    if (!v.preempt) lines.push("    nopreempt");
    lines.push("    virtual_ipaddress {");
    for (const a of v.virtualIps) lines.push(`        ${a.address}/${a.prefix} dev ${m.interface ?? v.interface}`);
    lines.push("    }", "}", "");
  }
  return lines.join("\n");
}

function rolloutView(rolloutId: string) {
  const r = rollouts.get(rolloutId) ?? fail("not found", 404);
  const elapsed = Date.now() - r.startedAt;
  const step = 2_500;
  const nodes = r.nodeIds.map((nodeId, position) => {
    const node = state.nodes.find((n) => n.id === nodeId)!;
    const startAt = position * step;
    const skipped = !node.online || node.configMode !== "managed";
    const status = skipped
      ? "skipped"
      : elapsed < startAt
        ? "pending"
        : elapsed < startAt + step
          ? "applying"
          : "applied";
    if (status === "applied") node.behind = false;
    const output =
      status === "pending" || skipped
        ? []
        : [
            "Testing the new config with keepalived",
            "Writing /etc/keepalived/conf.d/keepwatch.conf",
            "Reloading keepalived",
          ]
            .slice(0, status === "applying" ? Math.min(3, Math.floor((elapsed - startAt) / 800) + 1) : 3)
            .concat(status === "applied" ? ["Applied"] : []);
    return {
      nodeId,
      name: node.name,
      position,
      status,
      error: skipped ? (node.online ? "monitored only" : "agent is offline") : null,
      output,
    };
  });
  const done = nodes.every((n) => n.status !== "pending" && n.status !== "applying");
  return {
    rollout: {
      id: rolloutId,
      clusterId: r.clusterId,
      status: done ? "succeeded" : "running",
      error: null,
      startedAt: iso(r.startedAt),
      finishedAt: done ? iso(Date.now()) : null,
      nodes,
    },
  };
}

function overview() {
  const now = Date.now();
  const days = 30;
  const DAY = 86_400_000;
  const start = Math.floor(now / DAY) * DAY - (days - 1) * DAY;
  const failovers = Array.from({ length: days }, (_, i) => ({ day: start + i * DAY, failovers: 0 }));
  for (const e of state.events) {
    if (e.type !== "failover" || e.createdAt < start) continue;
    failovers[Math.floor((e.createdAt - start) / DAY)]!.failovers++;
  }
  const online = state.nodes.filter((n) => n.online).length;
  return {
    clusters: state.clusters.map(serializeCluster),
    nodes: state.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      clusterId: n.clusterId,
      online: n.online,
      configMode: n.configMode,
      service: "active",
      drift: n.drift,
      problems: n.failingChecks.map((c) => `check:${c.id}`),
    })),
    counts: {
      clusters: state.clusters.length,
      vips: state.vips.length,
      nodes: state.nodes.length,
      nodesOnline: online,
      agents: state.nodes.length,
      agentsConnected: online,
      splitBrain: 0,
      noMaster: state.vips.filter((v) => !master(v)).length,
      eventsToday: state.events.filter((e) => e.createdAt > now - DAY).length,
    },
    failovers,
    recentEvents: [...state.events].reverse().slice(0, 10).map(serializeEvent),
  };
}

function eventsPage(url: URL) {
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(5, Number(url.searchParams.get("pageSize") ?? 25) || 25));
  const types = url.searchParams.get("type")?.split(",");
  const severity = url.searchParams.get("severity");
  const q = url.searchParams.get("q")?.toLowerCase();
  const items = [...state.events]
    .reverse()
    .filter((e) => !types || types.includes(e.type))
    .filter((e) => !severity || e.severity === severity)
    .filter((e) => !q || `${e.title} ${e.message}`.toLowerCase().includes(q));
  return {
    total: items.length,
    page,
    pageSize,
    items: items.slice((page - 1) * pageSize, page * pageSize).map(serializeEvent),
  };
}

const system = () => ({
  version: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.1.0",
  commit: typeof __APP_COMMIT__ !== "undefined" ? __APP_COMMIT__ : null,
  baseUrl: "https://keepwatch.example.com",
  agentRepo: "tfourj/KeepWatch",
  timezone: "UTC",
  latestAgent: { version: "1.2.0", url: "https://github.com/tfourj/KeepWatch/releases", checkedAt: startedAt },
  latestAgentError: null,
  agentReleaseCheckedAt: startedAt,
});

const ROUTES: [string, RegExp, Handler][] = [
  ["GET", /^\/health$/, () => ({ status: "ok", version: system().version, commit: system().commit })],
  ["GET", /^\/overview$/, () => overview()],
  ["GET", /^\/clusters$/, () => ({ clusters: state.clusters.map(serializeCluster) })],
  [
    "POST",
    /^\/clusters$/,
    (_p, _u, body) => {
      const input = clusterInputSchema.parse(body);
      const cluster = { id: `c-${id()}`, ...input };
      state.clusters.push(cluster);
      return { cluster: serializeCluster(cluster) };
    },
  ],
  [
    "PATCH",
    /^\/clusters\/([^/]+)$/,
    ([cid], _u, body) => {
      const cluster = state.clusters.find((c) => c.id === cid) ?? fail("not found", 404);
      Object.assign(cluster, clusterInputSchema.partial().parse(body));
      return { cluster: serializeCluster(cluster) };
    },
  ],
  [
    "DELETE",
    /^\/clusters\/([^/]+)$/,
    ([cid]) => {
      state.clusters = state.clusters.filter((c) => c.id !== cid);
      state.vips = state.vips.filter((v) => v.clusterId !== cid);
      state.checks = state.checks.filter((k) => k.clusterId !== cid);
      for (const n of state.nodes) if (n.clusterId === cid) n.clusterId = null;
      return { ok: true };
    },
  ],
  ["POST", /^\/clusters\/([^/]+)\/instances$/, ([cid], _u, body) => saveVip(cid!, body)],
  [
    "PUT",
    /^\/clusters\/([^/]+)\/instances\/([^/]+)$/,
    ([cid, vid], _u, body) => saveVip(cid!, body, findVip(cid!, vid!)),
  ],
  [
    "DELETE",
    /^\/clusters\/([^/]+)\/instances\/([^/]+)$/,
    ([cid, vid]) => {
      const vip = findVip(cid!, vid!);
      state.vips = state.vips.filter((v) => v !== vip);
      return { ok: true };
    },
  ],
  [
    "POST",
    /^\/clusters\/([^/]+)\/instances\/([^/]+)\/maintenance$/,
    ([cid, vid], _u, body) => {
      const vip = findVip(cid!, vid!);
      const member = vip.members.find((m) => m.nodeId === (body.nodeId ?? master(vip)?.nodeId)) ?? fail("not a member");
      const node = nodeName(member.nodeId);
      member.maintenance = !!body.on;
      const address = vip.virtualIps.map((v) => v.address).join(", ");
      emit(
        body.on ? "maintenance_on" : "maintenance_off",
        `Maintenance ${body.on ? "on" : "off"} for ${vip.name} on ${node}`,
        body.on
          ? `${node} gave up ${vip.name} (${address}) for maintenance`
          : `${node} takes part in ${vip.name} again`,
        { nodeId: member.nodeId, clusterId: cid, instanceId: vip.id },
      );
      elect(vip, body.on ? `${node} is in maintenance` : "a member with a higher priority took over");
      return { ok: true };
    },
  ],
  [
    "POST",
    /^\/clusters\/([^/]+)\/checks$/,
    ([cid], _u, body) => {
      const input = checkInputSchema.parse(body);
      if (state.checks.some((k) => k.clusterId === cid && k.key === input.key)) fail(`${input.key} already exists`);
      const check = { id: `k-${id()}`, clusterId: cid!, ...input };
      state.checks.push(check);
      return { check };
    },
  ],
  [
    "PUT",
    /^\/clusters\/([^/]+)\/checks\/([^/]+)$/,
    ([cid, kid], _u, body) => {
      const check = state.checks.find((k) => k.id === kid && k.clusterId === cid) ?? fail("not found", 404);
      Object.assign(check, checkInputSchema.parse(body));
      return { check };
    },
  ],
  [
    "DELETE",
    /^\/clusters\/([^/]+)\/checks\/([^/]+)$/,
    ([, kid]) => {
      state.checks = state.checks.filter((k) => k.id !== kid);
      for (const v of state.vips) v.checkIds = v.checkIds.filter((x) => x !== kid);
      return { ok: true };
    },
  ],
  [
    "POST",
    /^\/clusters\/([^/]+)\/plan$/,
    ([cid]) => ({
      nodes: state.nodes
        .filter((n) => n.clusterId === cid && state.vips.some((v) => v.members.some((m) => m.nodeId === n.id)))
        .map((n) => {
          if (!n.online) return { nodeId: n.id, name: n.name, ok: false, skipped: "agent is offline", problems: [] };
          if (n.configMode !== "managed") {
            return { nodeId: n.id, name: n.name, ok: false, skipped: "monitored only", problems: [] };
          }
          const next = renderConfig(n);
          const current = n.behind ? next.replace(/priority (\d+)/, (_m, p) => `priority ${Number(p) + 10}`) : next;
          const main =
            "! Configuration File for keepalived\n\n# BEGIN keepwatch\ninclude /etc/keepalived/conf.d/keepwatch.conf\n# END keepwatch\n";
          return {
            nodeId: n.id,
            name: n.name,
            ok: true,
            problems: [],
            plan: {
              current,
              next,
              mainCurrent: main,
              mainNext: main,
              changed: current !== next,
              hash: "h",
              instances: [],
              migratedFrom: [],
            },
          };
        }),
    }),
  ],
  [
    "POST",
    /^\/clusters\/([^/]+)\/apply$/,
    ([cid]) => {
      const nodeIds = state.nodes
        .filter((n) => n.clusterId === cid && state.vips.some((v) => v.members.some((m) => m.nodeId === n.id)))
        .map((n) => n.id);
      const rolloutId = `r-${id()}`;
      rollouts.set(rolloutId, { clusterId: cid!, startedAt: Date.now(), nodeIds });
      setTimeout(
        () =>
          emit(
            "config_applied",
            `Config applied to ${clusterName(cid!)}`,
            `Applied the keepalived config to ${clusterName(cid!)}`,
            {
              clusterId: cid,
            },
          ),
        nodeIds.length * 2_500,
      );
      return { rolloutId };
    },
  ],
  ["GET", /^\/clusters\/([^/]+)\/rollouts\/([^/]+)$/, ([, rid]) => rolloutView(rid!)],
  ["POST", /^\/clusters\/([^/]+)\/import$/, () => fail(NOT_IN_DEMO)],
  ["GET", /^\/nodes$/, () => ({ nodes: state.nodes.map(serializeNode) })],
  [
    "GET",
    /^\/nodes\/([^/]+)$/,
    ([nid]) => ({ node: serializeNode(state.nodes.find((n) => n.id === nid) ?? fail("not found", 404)) }),
  ],
  [
    "POST",
    /^\/nodes$/,
    (_p, _u, body) => {
      if (!state.clusters.some((c) => c.id === body.clusterId)) fail("clusterId: Pick a cluster");
      const n: DemoNode = {
        id: `n-${id()}`,
        name: String(body.name ?? "node"),
        description: body.description ?? null,
        clusterId: body.clusterId ?? null,
        configMode: null,
        ip: "10.0.0.99",
        iface: "eth0",
        agentVersion: "1.2.0",
        keepalivedVersion: "2.2.8",
        online: false,
        drift: false,
        behind: false,
        failingChecks: [],
        autoUpdate: true,
      };
      state.nodes.push(n);
      const node = serializeNode(n);
      return { node: { ...node, agent: null, status: null }, enrollment: enrollment() };
    },
  ],
  [
    "PATCH",
    /^\/nodes\/([^/]+)$/,
    ([nid], _u, body) => {
      const n = state.nodes.find((x) => x.id === nid) ?? fail("not found", 404);
      if (body.name !== undefined) n.name = body.name;
      if (body.description !== undefined) n.description = body.description;
      if (body.clusterId !== undefined) n.clusterId = body.clusterId;
      return { node: serializeNode(n) };
    },
  ],
  [
    "DELETE",
    /^\/nodes\/([^/]+)$/,
    ([nid]) => {
      state.nodes = state.nodes.filter((n) => n.id !== nid);
      for (const v of state.vips) v.members = v.members.filter((m) => m.nodeId !== nid);
      return { ok: true };
    },
  ],
  ["POST", /^\/nodes\/([^/]+)\/enroll$/, () => enrollment()],
  [
    "POST",
    /^\/nodes\/([^/]+)\/maintenance$/,
    ([nid], _u, body) => {
      for (const v of state.vips) {
        const m = v.members.find((x) => x.nodeId === nid);
        if (!m) continue;
        m.maintenance = !!body.on;
        elect(v, body.on ? `${nodeName(nid!)} is in maintenance` : "a member with a higher priority took over");
      }
      return { instances: [] };
    },
  ],
  ["POST", /^\/nodes\/([^/]+)\/service$/, () => ({})],
  [
    "POST",
    /^\/nodes\/([^/]+)\/logs$/,
    ([nid]) => ({
      log: [
        `Nov 19 08:12:03 ${nodeName(nid!)} Keepalived[811]: Starting Keepalived v2.2.8`,
        `Nov 19 08:12:03 ${nodeName(nid!)} Keepalived_vrrp[812]: (VI_web) Entering BACKUP STATE (init)`,
        `Nov 19 08:12:06 ${nodeName(nid!)} Keepalived_vrrp[812]: (VI_web) Entering MASTER STATE`,
      ].join("\n"),
    }),
  ],
  [
    "POST",
    /^\/nodes\/([^/]+)\/check-update$/,
    () => ({ ok: true, status: "current", version: "1.2.0", latestVersion: "1.2.0" }),
  ],
  [
    "PATCH",
    /^\/nodes\/([^/]+)\/auto-update$/,
    ([nid], _u, body) => {
      const n = state.nodes.find((x) => x.id === nid) ?? fail("not found", 404);
      n.autoUpdate = !!body.enabled;
      return { node: serializeNode(n) };
    },
  ],
  ["POST", /^\/nodes\/([^/]+)\/(detect|install|mode|unpair)$/, () => fail(NOT_IN_DEMO)],
  ["GET", /^\/events$/, (_p, url) => eventsPage(url)],
  ["POST", /^\/events\/deliveries\/(\d+)\/retry$/, () => fail(NOT_IN_DEMO)],
  ["GET", /^\/channels$/, () => state.channels.map(serializeChannel)],
  ["POST", /^\/channels\/test$/, () => ({ ok: false, error: NOT_IN_DEMO })],
  [
    "POST",
    /^\/channels$/,
    (_p, _u, body) => {
      const ch = {
        id: `ch-${id()}`,
        name: String(body.name),
        type: body.type,
        enabled: body.enabled ?? true,
        events: body.events ?? [],
        config: {},
        secretsSet: {},
      };
      state.channels.push(ch);
      return serializeChannel(ch);
    },
  ],
  [
    "PATCH",
    /^\/channels\/([^/]+)$/,
    ([chid], _u, body) => {
      const ch = state.channels.find((c) => c.id === chid) ?? fail("not found", 404);
      if (body.name !== undefined) ch.name = body.name;
      if (body.enabled !== undefined) ch.enabled = body.enabled;
      if (body.events !== undefined) ch.events = body.events;
      return serializeChannel(ch);
    },
  ],
  [
    "DELETE",
    /^\/channels\/([^/]+)$/,
    ([chid]) => {
      state.channels = state.channels.filter((c) => c.id !== chid);
      return { ok: true };
    },
  ],
  ["GET", /^\/settings$/, () => ({ settings, system: system() })],
  [
    "PATCH",
    /^\/settings$/,
    (_p, _u, body) => {
      settings = { ...settings, ...body };
      return { settings, system: system() };
    },
  ],
  ["POST", /^\/settings\/check-agent-release$/, () => system()],
  [
    "GET",
    /^\/security$/,
    () => ({
      twoFactorEnabled: true,
      loginChannelIds: state.channels.filter((c) => c.events.includes("login")).map((c) => c.id),
    }),
  ],
  ["PATCH", /^\/security\/login-channels$/, () => fail(NOT_IN_DEMO)],
  ["POST", /^\/security\/login-channels\/test$/, () => fail(NOT_IN_DEMO)],
  [
    "GET",
    /^\/security\/sessions$/,
    () => [
      {
        id: "s1",
        name: "Firefox on Linux",
        userAgent: null,
        ip: "203.0.113.7",
        signedInAt: iso(startedAt - 3_600_000),
        lastActiveAt: iso(Date.now()),
        current: true,
      },
      {
        id: "s2",
        name: "Safari on iOS",
        userAgent: null,
        ip: "198.51.100.23",
        signedInAt: iso(startedAt - 5 * 86_400_000),
        lastActiveAt: iso(startedAt - 7_200_000),
        current: false,
      },
    ],
  ],
  ["POST", /^\/security\/sessions\/(revoke|revoke-all)$/, () => fail(NOT_IN_DEMO)],
  [
    "GET",
    /^\/logs$/,
    (_p, url) => {
      const after = Number(url.searchParams.get("after")) || undefined;
      const level = url.searchParams.get("level") as "info" | "warn" | "error" | null;
      return {
        entries: logs.query({
          after,
          minLevel: level ?? undefined,
          scope: url.searchParams.get("scope") ?? undefined,
          q: url.searchParams.get("q") ?? undefined,
        }),
        lastId: logs.lastId,
        scopes: logs.scopes(),
        logLevel: "info",
      };
    },
  ],
];

function enrollment() {
  return {
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    serverUrl: "https://keepwatch.example.com",
    insecure: false,
    command:
      "curl -fsSL https://raw.githubusercontent.com/tfourj/KeepWatch/main/agent/install.sh | sh -s -- " +
      "--server https://keepwatch.example.com --token demo-token-not-valid",
    uninstallCommand: "curl -fsSL https://raw.githubusercontent.com/tfourj/KeepWatch/main/agent/uninstall.sh | sh",
  };
}

export async function demoRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
  const url = new URL(path, "http://demo.local");
  for (const [routeMethod, pattern, handler] of ROUTES) {
    if (routeMethod !== method.toUpperCase()) continue;
    const match = url.pathname.match(pattern);
    if (match) return structuredClone(handler(match.slice(1), url, (body ?? {}) as Body)) as T;
  }
  return fail("not found", 404);
}
