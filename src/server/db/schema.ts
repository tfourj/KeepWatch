import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { KaStatus } from "../../shared/keepalived";

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
