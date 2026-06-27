import type { ClientInfo } from "@shellular/protocol";

import { db } from "./index";

export type UserHostHistory = {
	hostId: string;
	machineId: string | null;
	platform: string | null;
	firstSeenAt: number;
	lastSeenAt: number;
	connectionCount: number;
};

export type UserDeviceHistory = {
	clientId: string;
	lastHostId: string;
	appVersion: string;
	platform: ClientInfo["platform"];
	deviceModel: string;
	deviceIsEmulator: boolean;
	deviceManufacturer: string;
	firstSeenAt: number;
	lastSeenAt: number;
	connectionCount: number;
};

export type UserConnectionHistory = {
	hosts: UserHostHistory[];
	devices: UserDeviceHistory[];
};

type UserConnectionHistoryRow = {
	hostId: string;
	clientId: string;
	appVersion: string;
	platform: ClientInfo["platform"];
	deviceModel: string;
	deviceIsEmulator: number;
	deviceManufacturer: string;
	firstSeenAt: number;
	lastSeenAt: number;
	connectionCount: number;
	hostMachineId: string | null;
	hostPlatform: string | null;
};

export function recordUserConnectionHistory(
	userId: string,
	clientInfo: ClientInfo,
): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO user_connection_history
		 (userId, hostId, clientId, appVersion, platform, deviceModel, deviceIsEmulator, deviceManufacturer, firstSeenAt, lastSeenAt, connectionCount)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
		 ON CONFLICT(userId, hostId, clientId)
		 DO UPDATE SET
			 appVersion = excluded.appVersion,
			 platform = excluded.platform,
			 deviceModel = excluded.deviceModel,
			 deviceIsEmulator = excluded.deviceIsEmulator,
			 deviceManufacturer = excluded.deviceManufacturer,
			 lastSeenAt = excluded.lastSeenAt,
			 connectionCount = user_connection_history.connectionCount + 1`,
	).run(
		userId,
		clientInfo.hostId,
		clientInfo.clientId,
		clientInfo.appVersion,
		clientInfo.platform,
		clientInfo.deviceModel,
		clientInfo.deviceIsEmulator ? 1 : 0,
		clientInfo.deviceManufacturer,
		now,
		now,
	);
}

export function listUserConnectionHistory(
	userId: string,
): UserConnectionHistory {
	const rows = db
		.prepare(
			`SELECT
				 history.hostId,
				 history.clientId,
				 history.appVersion,
				 history.platform,
				 history.deviceModel,
				 history.deviceIsEmulator,
				 history.deviceManufacturer,
				 history.firstSeenAt,
				 history.lastSeenAt,
				 history.connectionCount,
				 hosts.machineId AS hostMachineId,
				 hosts.platform AS hostPlatform
			 FROM user_connection_history history
			 LEFT JOIN hosts ON hosts.id = history.hostId
			 WHERE history.userId = ?
			 ORDER BY history.lastSeenAt DESC
			 LIMIT 500`,
		)
		.all(userId) as UserConnectionHistoryRow[];

	const hosts = new Map<string, UserHostHistory>();
	const devices = new Map<string, UserDeviceHistory>();

	for (const row of rows) {
		const host = hosts.get(row.hostId);
		if (host) {
			host.firstSeenAt = Math.min(host.firstSeenAt, row.firstSeenAt);
			host.lastSeenAt = Math.max(host.lastSeenAt, row.lastSeenAt);
			host.connectionCount += row.connectionCount;
		} else {
			hosts.set(row.hostId, {
				hostId: row.hostId,
				machineId: row.hostMachineId,
				platform: row.hostPlatform,
				firstSeenAt: row.firstSeenAt,
				lastSeenAt: row.lastSeenAt,
				connectionCount: row.connectionCount,
			});
		}

		const device = devices.get(row.clientId);
		if (device) {
			device.firstSeenAt = Math.min(device.firstSeenAt, row.firstSeenAt);
			device.lastSeenAt = Math.max(device.lastSeenAt, row.lastSeenAt);
			device.connectionCount += row.connectionCount;
		} else {
			devices.set(row.clientId, {
				clientId: row.clientId,
				lastHostId: row.hostId,
				appVersion: row.appVersion,
				platform: row.platform,
				deviceModel: row.deviceModel,
				deviceIsEmulator: row.deviceIsEmulator === 1,
				deviceManufacturer: row.deviceManufacturer,
				firstSeenAt: row.firstSeenAt,
				lastSeenAt: row.lastSeenAt,
				connectionCount: row.connectionCount,
			});
		}
	}

	return {
		hosts: [...hosts.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt),
		devices: [...devices.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt),
	};
}
