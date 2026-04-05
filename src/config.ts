import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

export const HOME_DIR = os.homedir();
export const DB_FILE_NAME = "shellular.db";
export const APP_DIR_NAME = ".shellular";
export const APP_DIR = join(HOME_DIR, APP_DIR_NAME);
export const DB_FILE = join(APP_DIR, DB_FILE_NAME);

export const initConfig = () => {
	if (!os.platform()) {
		throw new Error("Unsupported platform");
	}

	if (!existsSync(APP_DIR)) {
		mkdirSync(APP_DIR, { recursive: true });
	}
};
