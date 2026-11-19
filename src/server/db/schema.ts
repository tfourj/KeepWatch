import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { CheckParams, KaStatus, VirtualIp, VrrpState } from "../../shared/keepalived";

const now = sql`(unixepoch() * 1000)`;
const ts = () => integer({ mode: "timestamp_ms" });
const bool = () => integer({ mode: "boolean" });
const uuid = () => text().primaryKey().$defaultFn(() => crypto.randomUUID());

// Better Auth core tables (model names: user, session, account, verification)

export const user = sqliteTable("user", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: bool().notNull().default(false),
  image: text(),
  twoFactorEnabled: bool().notNull().default(false),
  createdAt: ts().notNull().default(now),
  updatedAt: ts().notNull().default(now),
});

export const session = sqliteTable("session", {
  id: text().primaryKey(),
  expiresAt: ts().notNull(),
  token: text().notNull().unique(),
  createdAt: ts().notNull().default(now),
  updatedAt: ts().notNull().default(now),
  ipAddress: text(),
  userAgent: text(),
  // Updated on API requests, unlike updatedAt which only moves when the session is renewed.
  lastActiveAt: ts(),
  lastIp: text(),
  userId: text()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = sqliteTable("account", {
  id: text().primaryKey(),
  accountId: text().notNull(),
  providerId: text().notNull(),
  userId: text()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text(),
  refreshToken: text(),
  idToken: text(),
  accessTokenExpiresAt: ts(),
  refreshTokenExpiresAt: ts(),
  scope: text(),
  password: text(),
  createdAt: ts().notNull().default(now),
  updatedAt: ts().notNull().default(now),
});

export const verification = sqliteTable("verification", {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: ts().notNull(),
  createdAt: ts().notNull().default(now),
  updatedAt: ts().notNull().default(now),
});

// Better Auth two-factor plugin. The secret and backup codes are encrypted with BETTER_AUTH_SECRET.
export const twoFactor = sqliteTable(
  "two_factor",
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    secret: text().notNull(),
    backupCodes: text().notNull(),
    verified: bool().notNull().default(true),
    failedVerificationCount: integer().notNull().default(0),
    lockedUntil: ts(),
  },
  (t) => [index("two_factor_user_idx").on(t.userId)],
);

// App tables

/** Install-wide key/value pairs. Secrets are stored encrypted. */
export const settings = sqliteTable("settings", {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: ts().notNull().default(now),
});

export const events = sqliteTable(
  "events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    type: text().notNull(),
    severity: text().notNull().default("info"),
    nodeId: text(),
    clusterId: text(),
    instanceId: text(),
    title: text().notNull(),
    message: text().notNull(),
    data: text({ mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: ts().notNull().default(now),
  },
  (t) => [index("events_created_idx").on(t.createdAt), index("events_type_idx").on(t.type)],
);

/** A cluster groups nodes that share virtual IPs. It is the unit of a config rollout. */
export const clusters = sqliteTable("clusters", {
  id: uuid(),
  name: text().notNull(),
  description: text(),
  createdAt: ts().notNull().default(now),
  updatedAt: ts().notNull().default(now),
});

/** A machine running keepalived and keepwatch-agent. */
export const nodes = sqliteTable("nodes", {
  id: uuid(),
  name: text().notNull(),
  description: text(),
  clusterId: text().references(() => clusters.id, { onDelete: "set null" }),
  /** managed: KeepWatch writes the config. monitor: read only. Null until the user chose. */
  configMode: text().$type<ConfigMode>(),
  online: bool().notNull().default(false),
  lastSeenAt: ts(),
  /** Last keepalived report from the agent. */
  status: text({ mode: "json" }).$type<KaStatus & { reportedAt: number }>(),
  /** Problems already notified, so each is reported once until it recovers. */
  problems: text({ mode: "json" }).$type<string[]>(),
  /** Existing vrrp_instance names the next apply comments out, after they were imported into KeepWatch. */
  migrateInstances: text({ mode: "json" }).$type<string[]>(),
  /** Hash of the spec last applied, to show which nodes are behind. */
  appliedSpecHash: text(),
  appliedAt: ts(),
  createdAt: ts().notNull().default(now),
  updatedAt: ts().notNull().default(now),
});

export type ConfigMode = "managed" | "monitor";

export const agents = sqliteTable("agents", {
  id: uuid(),
  nodeId: text()
    .notNull()
    .unique()
    .references(() => nodes.id, { onDelete: "cascade" }),
  /** Ed25519 key the agent signs its hello with. */
  publicKey: text().notNull(),
  /** X25519 key secret fields are sealed to. */
  sealKey: text().notNull(),
  version: text(),
  os: text(),
  arch: text(),
  hostname: text(),
  interfaces: text({ mode: "json" }).$type<AgentInterface[]>(),
  connected: bool().notNull().default(false),
  lastSeenAt: ts(),
  enrolledAt: ts().notNull().default(now),
  autoUpdate: bool().notNull().default(true),
  updateStatus: text(),
  latestVersion: text(),
  lastUpdateError: text(),
  updateCheckedAt: ts(),
});

export type AgentInterface = { name: string; mac: string; cidrs: string[] };

export const enrollmentTokens = sqliteTable("enrollment_tokens", {
  id: uuid(),
  nodeId: text()
    .notNull()
    .references(() => nodes.id, { onDelete: "cascade" }),
  tokenHash: text().notNull().unique(),
  expiresAt: ts().notNull(),
  usedAt: ts(),
  createdAt: ts().notNull().default(now),
});

export const commands = sqliteTable(
  "commands",
  {
    id: uuid(),
    agentId: text()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    type: text().notNull(),
    payload: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    createdAt: ts().notNull().default(now),
    sentAt: ts(),
    ackedAt: ts(),
    expiresAt: ts().notNull(),
    error: text(),
  },
  (t) => [index("commands_agent_status_idx").on(t.agentId, t.status)],
);

/** One VRRP instance: a set of virtual IPs that move between the member nodes. Called a VIP in the UI. */
export const vrrpInstances = sqliteTable(
  "vrrp_instances",
  {
    id: uuid(),
    clusterId: text()
      .notNull()
      .references(() => clusters.id, { onDelete: "cascade" }),
    /** vrrp_instance name in the config. */
    name: text().notNull(),
    /** What runs behind the addresses, for example "AdGuard Home". Only shown in the UI. */
    service: text(),
    vrid: integer().notNull(),
    vrrpVersion: integer().notNull().default(3),
    /** Default interface, members can override it. */
    interface: text().notNull(),
    advertInt: integer().notNull().default(1),
    preempt: bool().notNull().default(true),
    preemptDelay: integer().notNull().default(0),
    /** Unicast between members instead of multicast. */
    unicast: bool().notNull().default(true),
    /** Encrypted VRRPv2 password, null for none. */
    authPassEnc: text(),
    virtualIps: text({ mode: "json" }).$type<VirtualIp[]>().notNull(),
    // Runtime state, worked out from the members' reports
    masterNodeId: text(),
    masterSince: ts(),
    splitBrainSince: ts(),
    splitBrainNotified: bool().notNull().default(false),
    noMasterSince: ts(),
    noMasterNotified: bool().notNull().default(false),
    createdAt: ts().notNull().default(now),
    updatedAt: ts().notNull().default(now),
  },
  (t) => [index("vrrp_instances_cluster_idx").on(t.clusterId)],
);

export const instanceMembers = sqliteTable(
  "instance_members",
  {
    instanceId: text()
      .notNull()
      .references(() => vrrpInstances.id, { onDelete: "cascade" }),
    nodeId: text()
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    priority: integer().notNull(),
    /** Overrides the instance interface on this node. */
    interface: text(),
    initialState: text().$type<"MASTER" | "BACKUP">().notNull().default("BACKUP"),
    // Last reported state on this node
    state: text().$type<VrrpState>(),
    reportedPriority: integer(),
    stateSince: ts(),
    maintenance: bool().notNull().default(false),
    holdsVips: bool().notNull().default(false),
    reportedAt: ts(),
  },
  (t) => [primaryKey({ columns: [t.instanceId, t.nodeId] })],
);

/** A health check, shared by the VIPs of a cluster that use it. */
export const checks = sqliteTable("checks", {
  id: uuid(),
  clusterId: text()
    .notNull()
    .references(() => clusters.id, { onDelete: "cascade" }),
  name: text().notNull(),
  /** Id used in the config, unique per cluster. */
  key: text().notNull(),
  params: text({ mode: "json" }).$type<CheckParams>().notNull(),
  intervalSec: integer().notNull().default(2),
  timeoutSec: integer().notNull().default(2),
  fall: integer().notNull().default(2),
  rise: integer().notNull().default(2),
  weight: integer().notNull().default(0),
  createdAt: ts().notNull().default(now),
  updatedAt: ts().notNull().default(now),
});

export const instanceChecks = sqliteTable(
  "instance_checks",
  {
    instanceId: text()
      .notNull()
      .references(() => vrrpInstances.id, { onDelete: "cascade" }),
    checkId: text()
      .notNull()
      .references(() => checks.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.instanceId, t.checkId] })],
);

/** Every state change of a member, for the timeline and charts. */
export const stateTransitions = sqliteTable(
  "state_transitions",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    instanceId: text()
      .notNull()
      .references(() => vrrpInstances.id, { onDelete: "cascade" }),
    nodeId: text()
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    fromState: text(),
    toState: text().notNull(),
    at: ts().notNull().default(now),
  },
  (t) => [
    index("state_transitions_instance_at_idx").on(t.instanceId, t.at),
    index("state_transitions_at_idx").on(t.at),
  ],
);

export const configRollouts = sqliteTable("config_rollouts", {
  id: uuid(),
  clusterId: text()
    .notNull()
    .references(() => clusters.id, { onDelete: "cascade" }),
  status: text().$type<"running" | "succeeded" | "failed">().notNull().default("running"),
  error: text(),
  startedAt: ts().notNull().default(now),
  finishedAt: ts(),
});

export type RolloutNodeStatus = "pending" | "applying" | "applied" | "unchanged" | "failed" | "rolled_back" | "skipped";

export const configRolloutNodes = sqliteTable(
  "config_rollout_nodes",
  {
    rolloutId: text()
      .notNull()
      .references(() => configRollouts.id, { onDelete: "cascade" }),
    nodeId: text()
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    position: integer().notNull(),
    status: text().$type<RolloutNodeStatus>().notNull().default("pending"),
    commandId: text(),
    hash: text(),
    error: text(),
    output: text({ mode: "json" }).$type<string[]>(),
    startedAt: ts(),
    finishedAt: ts(),
  },
  (t) => [primaryKey({ columns: [t.rolloutId, t.nodeId] })],
);

export const channels = sqliteTable("channels", {
  id: uuid(),
  name: text().notNull(),
  type: text().notNull(),
  /** Encrypted provider config, never sent to the browser in full. */
  configEnc: text().notNull(),
  enabled: bool().notNull().default(true),
  events: text({ mode: "json" }).$type<string[]>().notNull(),
  /** Only events of these clusters, null for all. */
  clusterIds: text({ mode: "json" }).$type<string[] | null>(),
  /** Only events of these nodes, null for all. */
  nodeIds: text({ mode: "json" }).$type<string[] | null>(),
  titleTemplate: text(),
  bodyTemplate: text(),
  createdAt: ts().notNull().default(now),
  updatedAt: ts().notNull().default(now),
});

export const deliveries = sqliteTable(
  "deliveries",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    eventId: integer()
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    channelId: text()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    status: text().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    nextAttemptAt: ts(),
    lastError: text(),
    deliveredAt: ts(),
    createdAt: ts().notNull().default(now),
  },
  (t) => [index("deliveries_status_idx").on(t.status, t.nextAttemptAt), index("deliveries_event_idx").on(t.eventId)],
);

export const deliveryAttempts = sqliteTable("delivery_attempts", {
  id: integer().primaryKey({ autoIncrement: true }),
  deliveryId: integer()
    .notNull()
    .references(() => deliveries.id, { onDelete: "cascade" }),
  attempt: integer().notNull(),
  ok: bool().notNull(),
  error: text(),
  durationMs: integer(),
  createdAt: ts().notNull().default(now),
});
