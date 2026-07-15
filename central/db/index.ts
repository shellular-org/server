import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { env } from "@central/env";
import { logger } from "@shared/logger";
import { getPm2Info } from "@shared/utils";
import Database from "better-sqlite3";

const DB_DIR = path.dirname(env.DB_PATH);
mkdirSync(DB_DIR, { recursive: true });

export const db = new Database(env.DB_PATH);

// Production SQLite configuration for concurrent access
// WAL mode enables better concurrency for multi-process setup (PM2)
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL"); // Safer than FULL but faster than OFF
db.pragma("busy_timeout = 5000"); // 5 second timeout for locked database
db.pragma("foreign_keys = ON"); // Enable foreign key constraints

// Run initialization SQL only on the PM2 leader (instance 0) or when not running under PM2.
const { pm2Instance, isLeader } = getPm2Info();

if (isLeader) {
  // Run initialization SQL
  const initSQLPath = path.resolve(__dirname, "init.sql");
  logger.info(`📀⌛️ Running initialization SQL from ${initSQLPath}`);
  const start = Date.now();
  const initSql = readFileSync(initSQLPath, "utf-8");
  db.exec(initSql);

  const end = Date.now();
  logger.info(`📀✅ SQLite ready at ${env.DB_PATH} in ${end - start}ms`);
} else {
  logger.info(`📀⏭️ Skipping initialization SQL on non-leader instance (NODE_APP_INSTANCE=${pm2Instance})`);
}
