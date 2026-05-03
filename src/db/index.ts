import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";

import { logger } from "@/logger";
import getPm2Info from "@/utils";

const DATA_DIR = "data";
mkdirSync(DATA_DIR, { recursive: true });

const dbPath = resolve(DATA_DIR, "shellular.db");
export const db = new Database(dbPath);

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
	const initSQLPath = resolve(__dirname, "init.sql");
	logger.info(`📀⌛️ Running initialization SQL from ${initSQLPath}`);
	const start = Date.now();
	const initSql = readFileSync(initSQLPath, "utf-8");
	db.exec(initSql);

	const end = Date.now();
	logger.info(`📀✅ SQLite ready at ${dbPath} in ${end - start}ms`);
} else {
	logger.info(
		`📀⏭️ Skipping initialization SQL on non-leader instance (NODE_APP_INSTANCE=${pm2Instance})`,
	);
}
