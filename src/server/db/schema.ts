import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch() * 1000)`;
const ts = () => integer({ mode: "timestamp_ms" });
const bool = () => integer({ mode: "boolean" });

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
