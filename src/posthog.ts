import type { ClientInfo, HostInfo } from "@shellular/protocol";
import { PostHog } from "posthog-node";

import { env } from "@/env";
import { logger } from "@/logger";

/**
 * Shared PostHog client for product analytics (DAU, retention, etc.).
 *
 * We capture from the server rather than the client because
 * - server is the only place we have a *proven* userId
 * - Server-side capture also can't be blocked or spoofed by the app
 * - Also don't have to worry about Posthog's session replay thing for user privacy (ik it can be disabled but still)
 *
 * Analytics is enabled only when a PostHog key is configured *and* we're in
 * prod: the key is optional (self-hosters/forks/local runs can omit it), and
 * even with a key set, dev runs must not pollute DAU/retention with our own
 * testing. With no key, `posthog` stays null and every capture no-ops.
 */
const analyticsEnabled =
	env.POSTHOG_KEY !== undefined && env.NODE_ENV === "prod";
logger.info(
	`🐽 PostHog analytics ${analyticsEnabled ? "enabled 📊" : "disabled"}`,
);

const client: PostHog | null =
	analyticsEnabled && env.POSTHOG_KEY
		? new PostHog(env.POSTHOG_KEY, { host: env.POSTHOG_HOST })
		: null;

client?.on("error", (err) => {
	// Analytics must never take down or interfere with the relay.
	logger.warn("PostHog error:", err);
});

function capture(event: Parameters<PostHog["capture"]>[0]): void {
	// null client (no key / non-prod) means analytics is off — nothing to do.
	if (!client) {
		return;
	}

	client.capture(event);
}

/**
 * Every analytics event we capture, at a glance. Keyed by side of the relay
 * (`app` = mobile/web client, `cli` = host). Use these constants at call sites
 * instead of inline strings so event names stay consistent.
 */
const Events = {
	app: {
		connectionEstablished: "app_connection_established",
		legacyConnectionEstablished: "legacy_app_connection_established",
	},
	cli: {
		connectionEstablished: "cli_connection_established",
		hostActive: "cli_host_active",
	},
} as const;

function appConnectionProperties(clientInfo: ClientInfo, hostPlatform: string) {
	return {
		// `source` labels which side of the relay the event came from so app and
		// CLI analytics are never conflated.
		source: "app" as const,
		hostId: clientInfo.hostId,
		clientId: clientInfo.clientId,
		platform: clientInfo.platform,
		appVersion: clientInfo.appVersion,
		deviceIsEmulator: clientInfo.deviceIsEmulator,
		hostPlatform,
	};
}

export function captureAppConnection(
	userId: string,
	clientInfo: ClientInfo,
	hostPlatform: string,
): void {
	capture({
		distinctId: userId,
		event: Events.app.connectionEstablished,
		properties: {
			...appConnectionProperties(clientInfo, hostPlatform),
			authenticated: true,
			// Person profile props so users are filterable in PostHog.
			$set: {
				lastPlatform: clientInfo.platform,
				lastAppVersion: clientInfo.appVersion,
			},
		},
	});
}

/**
 * Legacy app connections have no proven userId (old app versions predating the
 * login, or forks that stripped login). We key these on the stable
 * clientId so a distinct install counts once, and keep them under a separate
 * event so they never inflate authenticated DAU/retention. A current appVersion
 * arriving here is a signal of a login-stripped rebuild rather than an old app.
 */
export function captureLegacyAppConnection(
	clientInfo: ClientInfo,
	hostPlatform: string,
): void {
	capture({
		distinctId: clientInfo.clientId,
		event: Events.app.legacyConnectionEstablished,
		properties: {
			...appConnectionProperties(clientInfo, hostPlatform),
			authenticated: false,
			// Mark the person profile so legacy installs are filterable but never
			// silently merged with a real authenticated user.
			$set: { isLegacy: true },
		},
	});
}

function hostProperties(hostInfo: HostInfo) {
	return {
		source: "cli" as const,
		hostId: hostInfo.id,
		// machineId lets you dedupe by physical machine in PostHog even though
		// events are keyed on the per-registration hostId.
		machineId: hostInfo.machineId,
		platform: hostInfo.platform,
		cliVersion: hostInfo.cliVersion,
	};
}

/** Fired once when a host (CLI) establishes its relay connection. */
export function captureCliConnection(hostInfo: HostInfo): void {
	capture({
		distinctId: hostInfo.id,
		event: Events.cli.connectionEstablished,
		properties: {
			...hostProperties(hostInfo),
			$set: { lastCliVersion: hostInfo.cliVersion, isHost: true },
		},
	});
}

/**
 * Daily-active heartbeat for a persistent host connection. A host can stay
 * connected for days off a single `cli_connection_established`, which would
 * undercount it as a DAU. Emitting one `cli_host_active` per host per UTC day
 * makes long-lived hosts count as active every day they're up. Callers must
 * dedupe per day (see the heartbeat loop) so this never fires more than once
 * per host per day.
 */
function captureCliHostActive(hostInfo: HostInfo): void {
	capture({
		distinctId: hostInfo.id,
		event: Events.cli.hostActive,
		properties: hostProperties(hostInfo),
	});
}

const HEARTBEAT_SWEEP_MS = 6 * 60 * 60 * 1000; // every 6 hours

// Tracks the last UTC day (YYYY-MM-DD) we emitted cli_host_active for a hostId,
// so a persistent host is counted active at most once per day.
const lastHostActiveDay = new Map<string, string>();
let heartbeatTimer: NodeJS.Timeout | null = null;

function utcDay(now = new Date()): string {
	return now.toISOString().slice(0, 10);
}

/**
 * Start the daily host-active heartbeat. Sweeps connected hosts every 6 hours
 * and emits one `cli_host_active` per host per UTC day so long-lived host
 * connections are counted as daily-active on every day they stay up, not just
 * their connect day. The sweep interval only governs how soon after the UTC day
 * boundary a persistent host is re-counted; the per-day dedup keeps emissions to
 * once per host per day regardless.
 *
 * `getHosts` is injected to avoid a circular import with the sessions module.
 */
export function startHostHeartbeatForPosthog(getHosts: () => HostInfo[]): void {
	// No point sweeping hosts to emit events that would no-op at the gate.
	if (!analyticsEnabled || heartbeatTimer) {
		return;
	}

	const sweep = () => {
		const day = utcDay();
		for (const hostInfo of getHosts()) {
			if (lastHostActiveDay.get(hostInfo.id) === day) {
				// if a host has already been counted for the day, then let's skip it
				continue;
			}

			lastHostActiveDay.set(hostInfo.id, day);
			captureCliHostActive(hostInfo);
		}
		// Drop entries for days that have rolled over so the map can't grow
		// unbounded as hosts churn.
		for (const [hostId, seenDay] of lastHostActiveDay) {
			if (seenDay !== day) {
				lastHostActiveDay.delete(hostId);
			}
		}
	};

	logger.info("Starting PostHog host-active heartbeat sweep");
	heartbeatTimer = setInterval(sweep, HEARTBEAT_SWEEP_MS);
	heartbeatTimer.unref?.();
}

/**
 * Flush any buffered events and stop the client. Call on graceful shutdown so
 * batched events aren't lost when the process exits.
 */
export async function shutdownPostHog(): Promise<void> {
	if (!client) {
		return;
	}

	try {
		await client.shutdown();
	} catch (err) {
		logger.warn("PostHog shutdown failed:", err);
	}
}
