import { z } from "zod";

export const MsgType = {
	/** CLI sends this to register itself as a host with the server */
	SESSION_HOST: "session:host",
	/** Server response confirming CLI is registered as a host */
	SESSION_HOSTED: "session:hosted",
	/** App sends this to join a host session */
	SESSION_JOIN: "session:join",
	/** Server response confirming app has joined a session */
	SESSION_JOINED: "session:joined",
	/** Error response during session establishment */
	SESSION_ERROR: "session:error",
	/** Server notifies CLI when a client (app) joins the session */
	SESSION_CLIENT_JOINED: "session:client-joined",
	/** Server notifies CLI when a client (app) leaves the session */
	SESSION_CLIENT_LEFT: "session:client-left",
	/** Heartbeat ping from CLI to server */
	PING: "ping",
	/** Heartbeat pong response from server to CLI */
	PONG: "pong",
	/** Request to list directory contents */
	FS_LIST: "fs:list",
	/** Response with directory listing entries */
	FS_LIST_RESULT: "fs:list:result",
	/** Request to read a file */
	FS_READ: "fs:read",
	/** Response with file content */
	FS_READ_RESULT: "fs:read:result",
	/** Request to write to a file */
	FS_WRITE: "fs:write",
	/** Response after file write completes */
	FS_WRITE_RESULT: "fs:write:result",
	/** Request to create a directory */
	FS_MKDIR: "fs:mkdir",
	/** Request to delete a file or directory */
	FS_DELETE: "fs:delete",
	/** Request to rename a file or directory */
	FS_RENAME: "fs:rename",
	/** Request to get file/directory stats */
	FS_STAT: "fs:stat",
	/** Response with file/directory stats */
	FS_STAT_RESULT: "fs:stat:result",
	/** Generic response for mkdir/delete/rename operations */
	FS_RESULT: "fs:result",
	/** Request to create a new terminal session */
	TERMINAL_CREATE: "terminal:create",
	/** Response confirming terminal creation with terminal ID */
	TERMINAL_CREATED: "terminal:created",
	/** Request to list all active terminals */
	TERMINAL_LIST: "terminal:list",
	/** Response with list of active terminals */
	TERMINAL_LIST_RESULT: "terminal:list:result",
	/** Request to attach to an existing terminal */
	TERMINAL_ATTACH: "terminal:attach",
	/** Response confirming attachment with buffer content */
	TERMINAL_ATTACHED: "terminal:attached",
	/** Terminal output data streamed from CLI to client */
	TERMINAL_DATA: "terminal:data",
	/** Request to resize terminal dimensions */
	TERMINAL_RESIZE: "terminal:resize",
	/** Request to close a terminal session */
	TERMINAL_CLOSE: "terminal:close",
	/** Response confirming terminal is closed */
	TERMINAL_CLOSED: "terminal:closed",
	/** Request to get system info */
	SYSMON_GET: "sysmon:get",
	/** Response with system info */
	SYSMON_RESULT: "sysmon:result",
	/** Request to open a browser from CLI to app */
	BROWSER_OPEN: "browser:open",
	/** Response with browser callback */
	BROWSER_CALLBACK: "browser:callback",
} as const;

export type MsgType = (typeof MsgType)[keyof typeof MsgType];

interface BaseMsg<TType extends string> {
	type: TType;
}

interface RespMsg {
	respTo?: string;
}

interface ErrorMsg {
	error?: string;
}

export interface SessionHostedMsg
	extends BaseMsg<typeof MsgType.SESSION_HOSTED>,
		RespMsg {
	data: {
		connectionId: string;
	};
}

export interface SessionJoinedMsg
	extends BaseMsg<typeof MsgType.SESSION_JOINED>,
		RespMsg {
	data: {
		hostname: string;
		platform: string;
		dir: string;
		machineId?: string;
		connectionId: string;
	};
}

export interface SessionErrorMsg
	extends BaseMsg<typeof MsgType.SESSION_ERROR>,
		RespMsg,
		ErrorMsg {
	error: string;
}

export interface PongMsg extends BaseMsg<typeof MsgType.PONG>, RespMsg {}

export interface SessionClientJoinedMsg
	extends BaseMsg<typeof MsgType.SESSION_CLIENT_JOINED>,
		RespMsg {
	data: {
		clientId: string;
		appVersion: string;
		platform: string;
	};
}

export interface SessionClientLeftMsg
	extends BaseMsg<typeof MsgType.SESSION_CLIENT_LEFT>,
		RespMsg {
	data: {
		clientId: string;
	};
}

export const SessionHostMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.SESSION_HOST),
	data: z.object({
		machineId: z.string(),
		hostname: z.string(),
		platform: z.string(),
		dir: z.string(),
	}),
});

export const SessionJoinMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.SESSION_JOIN),
	data: z.object({
		connection: z.string(),
		clientId: z.string(),
		appVersion: z.string(),
		platform: z.string(),
	}),
});

export const PingMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.PING),
});

export const AppRelayMsgSchema = z.object({
	id: z.string(),
	type: z.string(),
});

export const CliRelayMsgSchema = z.object({
	id: z.string(),
	type: z.string(),
	clientId: z.string(),
});

export type SessionHostMsg = z.infer<typeof SessionHostMsgSchema>;
export type SessionJoinMsg = z.infer<typeof SessionJoinMsgSchema>;
export type PingMsg = z.infer<typeof PingMsgSchema>;
export type AppRelayMsg = z.infer<typeof AppRelayMsgSchema>;
export type CliRelayMsg = z.infer<typeof CliRelayMsgSchema>;

export function parseMessage<TSchema extends z.ZodType>(
	raw: string,
	schema: TSchema,
): z.infer<TSchema> | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	const result = schema.safeParse(parsed);
	return result.success ? result.data : null;
}
