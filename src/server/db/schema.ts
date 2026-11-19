import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch() * 1000)`;
const ts = () => integer({ mode: "timestamp_ms" });

// App tables

/** Install-wide key/value pairs. Secrets are stored encrypted. */
export const settings = sqliteTable("settings", {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: ts().notNull().default(now),
});
