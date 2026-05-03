import { nanoid } from "nanoid";

import { env } from "@/env";
import { ConflictError } from "@/error/http";
import { logger } from "@/logger";
import { db } from "./index";

type Host = {
	id: string;
	machineId: string;
	platform: string;
	createdAt: number;
};

export function registerHost(machineId: string, platform: string): string {
	const countStmt = db.prepare(
		"SELECT COUNT(*) as count FROM hosts WHERE machineId = ?",
	);
	const { count } = countStmt.get(machineId) as { count: number };

	if (count >= 3) {
		logger.error(
			`Suspicious activity: machineId ${machineId} already has ${count} registrations`,
		);
		throw new ConflictError(
			`Suspicious activity: This machine already has registered hosts. If you believe this is an error, please contact support at ${env.CONTACT_EMAIL}.`,
		);
	}

	const hostId = nanoid(12);
	const createdAt = Date.now();

	const stmt = db.prepare(
		"INSERT INTO hosts (id, machineId, platform, createdAt) VALUES (?, ?, ?, ?)",
	);
	stmt.run(hostId, machineId, platform, createdAt);

	return hostId;
}

export function getHost(id: string): Host | undefined {
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

export function verifyHost(
	host: string | Host,
	checkHost: Omit<Host, "createdAt">,
): boolean {
	if (env.NODE_ENV === "dev") {
		logger.warn(
			"Development mode: Skipping host verification. Any host can connect with any machineId and platform.",
		);
		return true;
	}

	if (typeof host === "string") {
		const hostFromDb = getHost(host);
		if (!hostFromDb) {
			return false;
		}

		host = hostFromDb;
	}

	return (
		host.id === checkHost.id &&
		host.machineId === checkHost.machineId &&
		host.platform === checkHost.platform
	);
}
