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
	runAuthMigrations();

	const end = Date.now();
	logger.info(`📀✅ SQLite ready at ${dbPath} in ${end - start}ms`);
} else {
	logger.info(
		`📀⏭️ Skipping initialization SQL on non-leader instance (NODE_APP_INSTANCE=${pm2Instance})`,
	);
}

function runAuthMigrations(): void {
	ensureColumn(
		"oauth_accounts",
		"isPrimary",
		"ALTER TABLE oauth_accounts ADD COLUMN isPrimary INTEGER NOT NULL DEFAULT 0",
	);
	ensureColumn(
		"oauth_login_states",
		"purpose",
		"ALTER TABLE oauth_login_states ADD COLUMN purpose TEXT NOT NULL DEFAULT 'signin'",
	);
	ensureColumn(
		"oauth_login_states",
		"userId",
		"ALTER TABLE oauth_login_states ADD COLUMN userId TEXT",
	);
	db.exec(`
		CREATE TABLE IF NOT EXISTS auth_link_codes (
			codeHash TEXT PRIMARY KEY,
			userId TEXT NOT NULL,
			provider TEXT NOT NULL,
			providerAccountId TEXT NOT NULL,
			email TEXT NOT NULL,
			createdAt INTEGER NOT NULL,
			expiresAt INTEGER NOT NULL,
			usedAt INTEGER,
			FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
		);
	`);
	backfillPrimaryOAuthAccounts();
	ensureUserProviderIndex();
}

function ensureColumn(table: string, column: string, alterSql: string): void {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
		name: string;
	}>;
	if (!columns.some((row) => row.name === column)) {
		db.exec(alterSql);
	}
}

function backfillPrimaryOAuthAccounts(): void {
	const users = db
		.prepare("SELECT DISTINCT userId FROM oauth_accounts")
		.all() as Array<{ userId: string }>;

	const accountsForUser = db.prepare(
		`SELECT rowid, isPrimary
		 FROM oauth_accounts
		 WHERE userId = ?
		 ORDER BY createdAt ASC, updatedAt ASC, provider ASC, providerAccountId ASC`,
	);
	const updatePrimary = db.prepare(
		"UPDATE oauth_accounts SET isPrimary = ? WHERE rowid = ?",
	);

	for (const { userId } of users) {
		const accounts = accountsForUser.all(userId) as Array<{
			rowid: number;
			isPrimary: number;
		}>;
		if (accounts.length === 0) continue;
		const primary = accounts[0];
		for (const account of accounts) {
			updatePrimary.run(account.rowid === primary.rowid ? 1 : 0, account.rowid);
		}
	}
}

function ensureUserProviderIndex(): void {
	const duplicates = db
		.prepare(
			`SELECT userId, provider, COUNT(*) AS count
			 FROM oauth_accounts
			 GROUP BY userId, provider
			 HAVING count > 1`,
		)
		.all();
	if (duplicates.length > 0) {
		logger.error(
			"Skipping oauth_accounts user/provider unique index because duplicates exist",
			duplicates,
		);
		return;
	}
	db.exec(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_accounts_user_provider ON oauth_accounts (userId, provider)",
	);
}
