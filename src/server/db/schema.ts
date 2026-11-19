import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch() * 1000)`;
const ts = () => integer({ mode: "timestamp_ms" });

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
