import { ClientInfoSchema } from "@shellular/protocol";
import express, { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import {
	assertProvider,
	createAuthorizationUrl,
	createLinkAuthorizationUrl,
	getProfileFromCallback,
	listProviders,
} from "@/auth/providers";
import {
	assertProviderCanBeLinked,
	createExchangeCode,
	createLinkCode,
	exchangeCodeForTokens,
	exchangeLinkCodeForAccount,
	type LoginState,
	type ProviderProfile,
	refreshToken,
	revokeSessionByAccessToken,
	revokeSessionByRefreshToken,
	unlinkProviderAccount,
	upsertUserFromProvider,
	validateAccessToken,
} from "@/auth/store";
import {
	APP_WEBSOCKET_TOKEN_TTL_SECONDS,
	createAppWebSocketToken,
} from "@/auth/ws-ticket";
import { getClient, verifyClient } from "@/db/client";
import { getHost } from "@/db/host";
import { listUserConnectionHistory } from "@/db/user-history";
import { env } from "@/env";
import { BadRequestError, ConflictError, ForbiddenError } from "@/error/http";

export const router = Router();

const authLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 60,
	standardHeaders: false,
	legacyHeaders: false,
});

const OAuthStartSchema = z.object({
	provider: z.string(),
});

const OAuthCallbackSchema = z.object({
	code: z.string().min(1),
	state: z.string().min(1),
});

const ExchangeSchema = z.object({
	code: z.string().min(1),
});

const RefreshSchema = z.object({
	refreshToken: z.string().min(1),
});

router.get("/auth/providers", (_req, res) => {
	res.json({ success: true, data: { providers: listProviders() } });
});

router.post("/auth/oauth/:provider/start", authLimiter, (req, res) => {
	const { provider: rawProvider } = OAuthStartSchema.parse(req.params);
	const provider = assertProvider(rawProvider);
	const authorizationUrl = createAuthorizationUrl(provider);
	res.json({ success: true, data: { authorizationUrl } });
});

router.post("/auth/oauth/:provider/link/start", authLimiter, (req, res) => {
	const user = requireAuthUser(req);
	const { provider: rawProvider } = OAuthStartSchema.parse(req.params);
	const provider = assertProvider(rawProvider);
	assertProviderCanBeLinked(user.id, provider);
	const authorizationUrl = createLinkAuthorizationUrl(provider, user.id);
	res.json({ success: true, data: { authorizationUrl } });
});

router.get("/auth/oauth/:provider/callback", authLimiter, async (req, res) => {
	const provider = assertProvider(String(req.params.provider));
	if (provider === "apple") {
		throw new BadRequestError("Apple sign-in callback must use POST.");
	}

	const parsed = OAuthCallbackSchema.safeParse(req.query);
	if (!parsed.success) {
		res.redirect(callbackUrl({ error: "invalid_callback" }));
		return;
	}

	try {
		const result = await getProfileFromCallback(
			provider,
			parsed.data.code,
			parsed.data.state,
		);
		res.redirect(callbackUrl(completeOAuthCallback(result)));
	} catch (error) {
		res.redirect(callbackUrl({ error: callbackError(error) }));
	}
});

router.post(
	"/auth/oauth/apple/callback",
	authLimiter,
	express.urlencoded({ extended: false }),
	async (req, res) => {
		const parsed = OAuthCallbackSchema.safeParse(req.body);
		if (!parsed.success) {
			res.redirect(callbackUrl({ error: "invalid_callback" }));
			return;
		}

		try {
			const result = await getProfileFromCallback(
				"apple",
				parsed.data.code,
				parsed.data.state,
				typeof req.body.user === "string" ? req.body.user : undefined,
			);
			res.redirect(callbackUrl(completeOAuthCallback(result)));
		} catch (error) {
			res.redirect(callbackUrl({ error: callbackError(error) }));
		}
	},
);

router.post("/auth/exchange", authLimiter, (req, res) => {
	const { code } = ExchangeSchema.parse(req.body);
	res.json({ success: true, data: exchangeCodeForTokens(code) });
});

router.post("/auth/oauth/link/exchange", authLimiter, (req, res) => {
	const user = requireAuthUser(req);
	const { code } = ExchangeSchema.parse(req.body);
	res.json({
		success: true,
		data: { user: exchangeLinkCodeForAccount(code, user.id) },
	});
});

router.post("/auth/refresh", authLimiter, (req, res) => {
	const { refreshToken: token } = RefreshSchema.parse(req.body);
	res.json({ success: true, data: refreshToken(token) });
});

router.get("/auth/me", (req, res) => {
	const user = requireAuthUser(req);
	res.json({ success: true, data: { user } });
});

router.get("/auth/history", (req, res) => {
	const user = requireAuthUser(req);
	res.json({
		success: true,
		data: { history: listUserConnectionHistory(user.id) },
	});
});

router.post("/auth/ws-token", (req, res) => {
	const user = requireAuthUser(req);
	const clientInfo = ClientInfoSchema.parse(req.body);

	if (!getHost(clientInfo.hostId)) {
		throw new BadRequestError("Host is not available.");
	}

	const existingClient = getClient(clientInfo.clientId);
	if (existingClient && !verifyClient(clientInfo)) {
		throw new BadRequestError("Client verification failed.");
	}

	res.json({
		success: true,
		data: {
			wsToken: createAppWebSocketToken(user.id, clientInfo),
			expiresIn: APP_WEBSOCKET_TOKEN_TTL_SECONDS,
		},
	});
});

router.post("/auth/logout", (req, res) => {
	const accessToken = getBearerToken(req);
	if (accessToken) {
		revokeSessionByAccessToken(accessToken);
	}
	const refresh = RefreshSchema.safeParse(req.body);
	if (refresh.success) {
		revokeSessionByRefreshToken(refresh.data.refreshToken);
	}
	res.json({ success: true });
});

router.delete("/auth/oauth/accounts/:provider", authLimiter, (req, res) => {
	const user = requireAuthUser(req);
	const provider = assertProvider(String(req.params.provider));
	res.json({
		success: true,
		data: { user: unlinkProviderAccount(user.id, provider) },
	});
});

export function requireAuthUser(req: express.Request) {
	const token = getBearerToken(req);
	if (!token) throw new ForbiddenError("Authentication required.");
	const user = validateAccessToken(token);
	if (!user) throw new ForbiddenError("Authentication required.");
	return user;
}

function getBearerToken(req: express.Request): string | null {
	const header = req.headers.authorization;
	if (!header?.startsWith("Bearer ")) return null;
	return header.slice("Bearer ".length).trim() || null;
}

function callbackUrl(params: Record<string, string>): string {
	const url = new URL(env.AUTH_APP_CALLBACK_URL);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}
	return url.toString();
}

function completeOAuthCallback(result: {
	profile: ProviderProfile;
	loginState: LoginState;
}): Record<string, string> {
	if (result.loginState.purpose === "link") {
		if (!result.loginState.userId) {
			throw new BadRequestError("Invalid account-linking request.");
		}
		return {
			linkCode: createLinkCode(result.loginState.userId, result.profile),
		};
	}

	const user = upsertUserFromProvider(result.profile);
	return { code: createExchangeCode(user.id) };
}

function callbackError(error: unknown): string {
	if (
		error instanceof BadRequestError ||
		error instanceof ForbiddenError ||
		error instanceof ConflictError
	) {
		return error.message;
	}
	return "oauth_failed";
}
