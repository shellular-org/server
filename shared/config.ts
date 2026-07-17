import { join } from "node:path";

// relative this file : server/shared/config.ts -> server/
export const PROJECT_ROOT_DIR = join(__dirname, "..");
