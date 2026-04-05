import { existsSync, mkdirSync } from "node:fs";
import sqlite from "better-sqlite3";
import { APP_DIR, DB_FILE } from "config";

type UpdateTable = {
	version: number;
	sql: string;
};

if (!existsSync(APP_DIR)) {
	mkdirSync(APP_DIR, { recursive: true });
}

const db = sqlite(DB_FILE);
const DB_VERSION = 1;
const createTables: string[] = [];
const updateTables: UpdateTable[] = [];

async function init() {
	const version = db.pragma("user_version", { simple: true }) as number;

	const transactions = db.transaction(() => {
		for (const createTable of createTables) {
			try {
				db.exec(createTable);
			} catch (error) {
				console.error("Error creating table:", error, createTable);
			}
		}
	});
	transactions();

	if (version < DB_VERSION) {
		const transactions = db.transaction(() => {
			for (const updateTable of updateTables) {
				if (updateTable.version <= version) {
					continue;
				}

				try {
					db.exec(updateTable.sql);
				} catch (error) {
					console.error("Error updating table:", error, updateTable);
				}
			}
		});
		transactions();
	}

	db.pragma(`user_version = ${DB_VERSION}`);
}

export default db;
export { init, createTables, updateTables };
