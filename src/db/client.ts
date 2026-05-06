import type { ClientInfo } from "@shellular/protocol";

import { db } from "./index";

type Client = {
	id: string;
	platform: string;
	deviceModel: string;
	deviceIsEmulator: number;
	deviceManufacturer: string;
	appVersion: string;
	createdAt: number;
};

export function registerClient(clientInfo: ClientInfo): void {
	const stmt = db.prepare(
		"INSERT OR IGNORE INTO clients (id, platform, deviceModel, deviceIsEmulator, deviceManufacturer, appVersion, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	stmt.run(
		clientInfo.clientId,
		clientInfo.platform,
		clientInfo.deviceModel,
		clientInfo.deviceIsEmulator ? 1 : 0,
		clientInfo.deviceManufacturer,
		clientInfo.appVersion,
		Date.now(),
	);
}

export function getClient(id: string): Client | undefined {
	const stmt = db.prepare("SELECT * FROM clients WHERE id = ?");
	return stmt.get(id) as Client | undefined;
}

export function verifyClient(clientInfo: ClientInfo): boolean {
	const existing = getClient(clientInfo.clientId);
	if (!existing) {
		return false;
	}

	return (
		existing.platform === clientInfo.platform &&
		existing.deviceModel === clientInfo.deviceModel &&
		existing.deviceIsEmulator === (clientInfo.deviceIsEmulator ? 1 : 0) &&
		existing.deviceManufacturer === clientInfo.deviceManufacturer
	);
}
