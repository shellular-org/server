import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { type ClientInfo, ClientInfoSchema } from "@shellular/protocol";
import { z } from "zod";
import { env } from "@/env";

export const APP_WEBSOCKET_TOKEN_TTL_SECONDS = 30;

const TOKEN_HEADER = { alg: "HS256", typ: "JWT" };
// Tickets are not stored or consumed server-side in this pass; replay is limited
// to the short TTL.
const TOKEN_SECRET = env.WS_TOKEN_SECRET;

const AppWebSocketTokenPayloadSchema = ClientInfoSchema.extend({
	userId: z.string().min(1),
	iat: z.number().int(),
	exp: z.number().int(),
	jti: z.string().min(1),
});

export type AppWebSocketTokenPayload = z.infer<
	typeof AppWebSocketTokenPayloadSchema
>;

export function createAppWebSocketToken(
	userId: string,
	clientInfo: ClientInfo,
): string {
	const iat = Math.floor(Date.now() / 1000);
	const payload: AppWebSocketTokenPayload = {
		...clientInfo,
		userId,
		iat,
		exp: iat + APP_WEBSOCKET_TOKEN_TTL_SECONDS,
		jti: randomBytes(16).toString("base64url"),
	};

	const encodedHeader = encodeJson(TOKEN_HEADER);
	const encodedPayload = encodeJson(payload);
	const signingInput = `${encodedHeader}.${encodedPayload}`;
	return `${signingInput}.${sign(signingInput)}`;
}

export function verifyAppWebSocketToken(
	token: string,
): AppWebSocketTokenPayload | null {
	const parts = token.split(".");
	if (parts.length !== 3) return null;

	const [encodedHeader, encodedPayload, signature] = parts;
	const signingInput = `${encodedHeader}.${encodedPayload}`;
	if (!constantTimeEqual(signature, sign(signingInput))) return null;

	const header = decodeJson(encodedHeader);
	if (
		!header ||
		header.alg !== TOKEN_HEADER.alg ||
		header.typ !== TOKEN_HEADER.typ
	) {
		return null;
	}

	const payload = decodeJson(encodedPayload);
	const parsed = AppWebSocketTokenPayloadSchema.safeParse(payload);
	if (!parsed.success) return null;

	const now = Math.floor(Date.now() / 1000);
	if (parsed.data.exp <= now) return null;

	return parsed.data;
}

function encodeJson(value: unknown): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJson(value: string): Record<string, unknown> | null {
	try {
		const decoded = Buffer.from(value, "base64url").toString("utf8");
		const parsed = JSON.parse(decoded);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed
			: null;
	} catch {
		return null;
	}
}

function sign(value: string): string {
	return createHmac("sha256", TOKEN_SECRET).update(value).digest("base64url");
}

function constantTimeEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return (
		leftBuffer.length === rightBuffer.length &&
		timingSafeEqual(leftBuffer, rightBuffer)
	);
}
