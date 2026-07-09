import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

export const HOME_DIR = os.homedir();
export const DB_FILE_NAME = "shellular.db";
export const APP_DIR_NAME = ".shellular";
export const APP_DIR = join(HOME_DIR, APP_DIR_NAME);
export const DB_FILE = join(APP_DIR, DB_FILE_NAME);

// relative this file : server/src/config.ts -> server/
export const PROJECT_ROOT_DIR = join(__dirname, "..");

export const GIT_COMMIT = (() => {
	try {
		const sha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
		const message = execSync("git log -1 --pretty=%s", {
			encoding: "utf8",
		}).trim();
		return { sha, message };
	} catch {
		return { sha: "unknown", message: "unknown" };
	}
})();

export const initConfig = () => {
	if (!existsSync(APP_DIR)) {
		mkdirSync(APP_DIR, { recursive: true });
	}
};
