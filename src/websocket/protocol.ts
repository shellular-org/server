import { z } from "zod";

import { logger } from "@/logger";

export const MsgType = {
	/** CLI sends this to register itself as a host with the server */
	SESSION_HOST: "session:host",
	/** Server response confirming CLI is registered as a host */
	SESSION_HOSTED: "session:hosted",
	/** Server response confirming app has joined a session */
	SESSION_JOINED: "session:joined",
	/** Error response during session establishment */
	SESSION_ERROR: "session:error",
	/** Server notifies CLI when a client (app) joins the session */
	SESSION_CLIENT_JOINED: "session:client-joined",
	/** Server notifies CLI when a client (app) leaves the session */
	SESSION_CLIENT_LEFT: "session:client-left",
	/** Server notifies CLI of a pending client connection awaiting approval */
	SESSION_CLIENT_JOIN: "session:client-join",
	/** CLI sends this to report whether a pending client was approved */
	SESSION_CLIENT_JOIN_RESULT: "session:client-join:result",
	/** Heartbeat ping from CLI to server */
	PING: "ping",
	/** Heartbeat pong response from server to CLI */
	PONG: "pong",
} as const;

export type MsgType = (typeof MsgType)[keyof typeof MsgType];

interface BaseMsg<TType extends string> {
	type: TType;
}

export interface SessionHostedMsg
	extends BaseMsg<typeof MsgType.SESSION_HOSTED> {
	data: {
		sessionId: string;
	};
}

export interface SessionJoinedMsg
	extends BaseMsg<typeof MsgType.SESSION_JOINED> {
	respTo?: string;
	data: {
		hostname: string;
		platform: string;
		dir: string;
		machineId: string;
		sessionId: string;
	};
}

export interface SessionErrorMsg extends BaseMsg<typeof MsgType.SESSION_ERROR> {
	respTo?: string;
	error: string;
}

export interface PongMsg extends BaseMsg<typeof MsgType.PONG> {
	respTo?: string;
}

export interface SessionClientJoinedMsg
	extends BaseMsg<typeof MsgType.SESSION_CLIENT_JOINED> {
	data: {
		clientId: string;
		appVersion: string;
		platform: string;
	};
}

export interface SessionClientLeftMsg
	extends BaseMsg<typeof MsgType.SESSION_CLIENT_LEFT> {
	data: {
		clientId: string;
	};
}

export interface SessionClientJoinMsg
	extends BaseMsg<typeof MsgType.SESSION_CLIENT_JOIN> {
	data: {
		clientId: string;
		appVersion: string;
		platform: string;
	};
}

export const SessionHostMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.SESSION_HOST),
	data: z.object({
		id: z.string(),
		machineId: z.string(),
		hostname: z.string(),
		platform: z.string(),
		dir: z.string(),
	}),
});
export const BaseMsgSchema = z
	.object({
		id: z.string(),
		type: z.string(),
	})
	.catchall(z.unknown());

export const PingMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.PING),
});

export const SessionClientJoinResultMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.SESSION_CLIENT_JOIN_RESULT),
	data: z.object({ clientId: z.string(), approved: z.boolean() }),
});

export const ClientToHostMsgSchema = BaseMsgSchema.extend({});

export const HostToClientMsgSchema = BaseMsgSchema.extend({
	/**
	 * Which client (app) to send this message to. The server will route it based on this `clientId`.
	 */
	clientId: z.string(),
});

export type BaseMsgParsed = z.infer<typeof BaseMsgSchema>;
export type SessionHostMsg = z.infer<typeof SessionHostMsgSchema>;
export type PingMsg = z.infer<typeof PingMsgSchema>;
export type ClientToHostMsg = z.infer<typeof ClientToHostMsgSchema>;
export type HostToClientMsg = z.infer<typeof HostToClientMsgSchema>;
export type SessionClientJoinResultMsg = z.infer<
	typeof SessionClientJoinResultMsgSchema
>;

export function parseBaseMessage(raw: string): BaseMsgParsed | null {
	try {
		const parsed = JSON.parse(raw);
		const result = BaseMsgSchema.safeParse(parsed);
		if (result.success) {
			return result.data;
		}

		logger.error("Failed to parse message:", raw);
		logger.error("", result.error);
		return null;
	} catch {
		return null;
	}
}
