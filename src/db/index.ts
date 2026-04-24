import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { env } from "@/env";
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

export function registerHost(machineId: string, platform: string): string {
	const hostId = nanoid(12);
	const createdAt = Date.now();

	const stmt = db.prepare(
		"INSERT INTO hosts (id, machineId, platform, createdAt) VALUES (?, ?, ?, ?)",
	);
	stmt.run(hostId, machineId, platform, createdAt);

	return hostId;
}

export function getHost(id: string) {
	if (env.NODE_ENV === "dev") {
		logger.warn(
			"Development mode: Skipping host lookup. Returning dummy host for any id.",
		);
		return {
			id,
			machineId: "dev-machine-id",
			platform: "dev-platform",
			createdAt: Date.now(),
		};
	}

	const stmt = db.prepare("SELECT * FROM hosts WHERE id = ?");
	return stmt.get(id) as
		| {
				id: string;
				machineId: string;
				platform: string;
				createdAt: number;
		  }
		| undefined;
}

export function verifyHost(id: string, machineId: string, platform: string) {
	if (env.NODE_ENV === "dev") {
		logger.warn(
			"Development mode: Skipping host verification. Any host can connect with any machineId and platform.",
		);
		return { id, machineId, platform, createdAt: Date.now() };
	}

	const stmt = db.prepare(
		"SELECT * FROM hosts WHERE id = ? AND machineId = ? AND platform = ?",
	);
	return stmt.get(id, machineId, platform) as
		| {
				id: string;
				machineId: string;
				platform: string;
				createdAt: number;
		  }
		| undefined;
}

export function addToWaitlist(
	name: string,
	email: string,
	social: string | null,
	platforms: string,
): { alreadyJoined: boolean } {
	const existing = db
		.prepare("SELECT id FROM waitlist WHERE email = ?")
		.get(email);

	if (existing) {
		return { alreadyJoined: true };
	}

	db.prepare(
		"INSERT INTO waitlist (id, name, email, social, platforms, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
	).run(nanoid(12), name, email, social ?? null, platforms, Date.now());

	return { alreadyJoined: false };
}

export function markWaitlistSheetsFailed(email: string) {
	db.prepare("UPDATE waitlist SET sheetsFailed = 1 WHERE email = ?").run(email);
}
