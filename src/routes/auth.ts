import { type ClientInfo, ClientInfoSchema } from "@shellular/protocol";
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
	type AuthUser,
	assertProviderCanBeLinked,
	createExchangeCode,
	createLinkCode,
	createSession,
	exchangeCodeForTokens,
	exchangeLinkCodeForAccount,
	getLoginStateCallbackUrl,
	type LoginState,
	linkProviderAccount,
	type ProviderProfile,
	refreshToken,
	revokeSessionByAccessToken,
	revokeSessionByRefreshToken,
	type TokenPair,
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

const OAuthStartBodySchema = z.object({
	callbackUrl: z.string().optional(),
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

const AUTH_ACCESS_COOKIE = "__Host-shellular_access";
const AUTH_REFRESH_COOKIE = "__Host-shellular_refresh";

router.get("/auth/providers", (_req, res) => {
	res.json({ success: true, data: { providers: listProviders() } });
});

router.post("/auth/oauth/:provider/start", authLimiter, (req, res) => {
	const { provider: rawProvider } = OAuthStartSchema.parse(req.params);
	const provider = assertProvider(rawProvider);
	const authorizationUrl = createAuthorizationUrl(provider, {
		callbackUrl: appCallbackUrl(req),
	});
	res.json({ success: true, data: { authorizationUrl } });
});

router.post("/auth/oauth/:provider/link/start", authLimiter, (req, res) => {
	const user = requireAuthUser(req);
	const { provider: rawProvider } = OAuthStartSchema.parse(req.params);
	const provider = assertProvider(rawProvider);
	assertProviderCanBeLinked(user.id, provider);
	const authorizationUrl = createLinkAuthorizationUrl(provider, user.id, {
		callbackUrl: appCallbackUrl(req),
	});
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

	const appCallbackUrl = getLoginStateCallbackUrl(parsed.data.state, provider);

	try {
		const result = await getProfileFromCallback(
			provider,
			parsed.data.code,
			parsed.data.state,
		);
		if (isBrowserCallbackUrl(result.loginState.callbackUrl)) {
			res.redirect(
				callbackUrl(
					completeBrowserOAuthCallback(res, result),
					result.loginState.callbackUrl,
				),
			);
			return;
		}
		res.redirect(
			callbackUrl(completeOAuthCallback(result), result.loginState.callbackUrl),
		);
	} catch (error) {
		res.redirect(callbackUrl({ error: callbackError(error) }, appCallbackUrl));
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

		const appCallbackUrl = getLoginStateCallbackUrl(parsed.data.state, "apple");

		try {
			const result = await getProfileFromCallback(
				"apple",
				parsed.data.code,
				parsed.data.state,
				typeof req.body.user === "string" ? req.body.user : undefined,
			);
			if (isBrowserCallbackUrl(result.loginState.callbackUrl)) {
				res.redirect(
					callbackUrl(
						completeBrowserOAuthCallback(res, result),
						result.loginState.callbackUrl,
					),
				);
				return;
			}
			res.redirect(
				callbackUrl(
					completeOAuthCallback(result),
					result.loginState.callbackUrl,
				),
			);
		} catch (error) {
			res.redirect(
				callbackUrl({ error: callbackError(error) }, appCallbackUrl),
			);
		}
	},
);

router.post("/auth/exchange", authLimiter, (req, res) => {
	const { code } = ExchangeSchema.parse(req.body);
	res.json({
		success: true,
		data: tokenPairResponse(req, exchangeCodeForTokens(code)),
	});
});

router.post("/auth/oauth/link/exchange", authLimiter, (req, res) => {
	const user = requireAuthUser(req);
	const { code } = ExchangeSchema.parse(req.body);
	res.json({
		success: true,
		data: {
			user: authUserResponse(req, exchangeLinkCodeForAccount(code, user.id)),
		},
	});
});

router.post("/auth/refresh", authLimiter, (req, res) => {
	const parsed = RefreshSchema.safeParse(req.body);
	const token = parsed.success
		? parsed.data.refreshToken
		: getCookie(req, AUTH_REFRESH_COOKIE);
	if (!token)
		throw new ForbiddenError("Your session expired. Please sign in again.");
	const data = refreshToken(token);
	if (!parsed.success) {
		setAuthCookies(res, data);
		res.json({ success: true, data: browserSessionData(req, data) });
		return;
	}
	res.json({ success: true, data: tokenPairResponse(req, data) });
});

router.get("/auth/me", (req, res) => {
	const user = requireAuthUser(req);
	res.json({ success: true, data: { user: authUserResponse(req, user) } });
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
	const requestedClientInfo = ClientInfoSchema.parse(req.body);
	const clientInfo = effectiveClientInfo(user.id, requestedClientInfo);

	if (!getHost(clientInfo.hostId)) {
		throw new BadRequestError("Host is not available.");
	}

	const existingClient = getClient(clientInfo.clientId);
	if (
		existingClient &&
		!isBrowserClientInfo(clientInfo) &&
		!verifyClient(clientInfo)
	) {
		throw new BadRequestError("Client verification failed.");
	}

	res.json({
		success: true,
		data: {
			wsToken: createAppWebSocketToken(user.id, clientInfo),
			expiresIn: APP_WEBSOCKET_TOKEN_TTL_SECONDS,
			clientId: clientInfo.clientId,
		},
	});
});

router.post("/auth/logout", (req, res) => {
	const accessToken = getBearerToken(req) ?? getCookie(req, AUTH_ACCESS_COOKIE);
	if (accessToken) {
		revokeSessionByAccessToken(accessToken);
	}
	const refresh = RefreshSchema.safeParse(req.body);
	if (refresh.success) {
		revokeSessionByRefreshToken(refresh.data.refreshToken);
	}
	const refreshCookie = getCookie(req, AUTH_REFRESH_COOKIE);
	if (refreshCookie) {
		revokeSessionByRefreshToken(refreshCookie);
	}
	clearAuthCookies(res);
	res.json({ success: true });
});

router.delete("/auth/oauth/accounts/:provider", authLimiter, (req, res) => {
	const user = requireAuthUser(req);
	const provider = assertProvider(String(req.params.provider));
	res.json({
		success: true,
		data: {
			user: authUserResponse(req, unlinkProviderAccount(user.id, provider)),
		},
	});
});

export function requireAuthUser(req: express.Request) {
	const token = getBearerToken(req) ?? getCookie(req, AUTH_ACCESS_COOKIE);
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

function effectiveClientInfo(
	userId: string,
	clientInfo: ClientInfo,
): ClientInfo {
	if (!isBrowserClientInfo(clientInfo)) {
		return clientInfo;
	}

	return {
		...clientInfo,
		clientId: userId,
	};
}

function isBrowserClientInfo(clientInfo: ClientInfo): boolean {
	return clientInfo.platform === "browser";
}

function appCallbackUrl(req: express.Request): string {
	const { callbackUrl: requestedCallbackUrl } = OAuthStartBodySchema.parse(
		req.body ?? {},
	);
	if (!requestedCallbackUrl) return env.AUTH_APP_CALLBACK_URL;

	let url: URL;
	try {
		url = new URL(requestedCallbackUrl);
	} catch {
		throw new BadRequestError("Invalid app callback URL.");
	}

	if (isBrowserAppCallbackUrl(req, url)) {
		url.hash = "";
		return url.toString();
	}

	if (url.host !== "auth-callback") {
		throw new BadRequestError("Invalid app callback URL.");
	}

	const defaultScheme = new URL(env.AUTH_APP_CALLBACK_URL).protocol;
	const allowedSchemes = new Set([
		defaultScheme,
		"shellular:",
		"shellular-dev:",
		"foxbiz:",
	]);
	if (!allowedSchemes.has(url.protocol)) {
		throw new BadRequestError("Invalid app callback URL.");
	}

	url.search = "";
	url.hash = "";
	return url.toString();
}

function isBrowserAppCallbackUrl(req: express.Request, url: URL): boolean {
	if (!isBrowserCallbackUrl(url.toString())) return false;

	const requestOrigin = req.headers.origin;
	if (!requestOrigin) {
		return false;
	}

	let origin: URL;
	try {
		origin = new URL(requestOrigin);
	} catch {
		return false;
	}

	if (origin.origin !== url.origin) {
		return false;
	}
	if (env.NODE_ENV === "dev") {
		return true;
	}

	return isTrustedWebAppOrigin(url);
}

function isTrustedWebAppOrigin(url: URL): boolean {
	if (url.protocol !== "https:") {
		return false;
	}
	return (
		url.hostname === "shellular.dev" || url.hostname.endsWith(".shellular.dev")
	);
}

function isBrowserCallbackUrl(callbackUrl: string | null | undefined): boolean {
	if (!callbackUrl) return false;
	try {
		const url = new URL(callbackUrl);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			!url.username &&
			!url.password &&
			url.searchParams.get("shellularAuthCallback") === "1"
		);
	} catch {
		return false;
	}
}

function callbackUrl(
	params: Record<string, string>,
	appCallbackUrl?: string | null,
): string {
	const url = new URL(appCallbackUrl ?? env.AUTH_APP_CALLBACK_URL);
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

function completeBrowserOAuthCallback(
	res: express.Response,
	result: {
		profile: ProviderProfile;
		loginState: LoginState;
	},
): Record<string, string> {
	if (result.loginState.purpose === "link") {
		if (!result.loginState.userId) {
			throw new BadRequestError("Invalid account-linking request.");
		}
		linkProviderAccount(result.loginState.userId, result.profile);
		return { linked: "1" };
	}

	const user = upsertUserFromProvider(result.profile);
	setAuthCookies(res, createSession(user.id));
	return { authenticated: "1" };
}

function setAuthCookies(res: express.Response, tokenPair: TokenPair): void {
	res.cookie(AUTH_ACCESS_COOKIE, tokenPair.accessToken, {
		...authCookieOptions(),
		expires: new Date(tokenPair.accessTokenExpiresAt),
	});
	res.cookie(AUTH_REFRESH_COOKIE, tokenPair.refreshToken, {
		...authCookieOptions(),
		expires: new Date(tokenPair.refreshTokenExpiresAt),
	});
}

function tokenPairResponse(
	req: express.Request,
	tokenPair: TokenPair,
): TokenPair {
	return {
		...tokenPair,
		user: authUserResponse(req, tokenPair.user),
	};
}

function browserSessionData(req: express.Request, tokenPair: TokenPair) {
	return {
		accessTokenExpiresAt: tokenPair.accessTokenExpiresAt,
		refreshTokenExpiresAt: tokenPair.refreshTokenExpiresAt,
		user: authUserResponse(req, tokenPair.user),
	};
}

function authUserResponse(req: express.Request, user: AuthUser): AuthUser {
	return {
		...user,
		avatarUrl: proxiedImageUrl(req, user.avatarUrl),
	};
}

function proxiedImageUrl(
	req: express.Request,
	imageUrl: string | null,
): string | null {
	if (!imageUrl) return null;
	try {
		const url = new URL(
			"/utils/image-proxy",
			`${req.protocol}://${req.get("host")}`,
		);
		url.searchParams.set("url", imageUrl);
		return url.toString();
	} catch {
		return imageUrl;
	}
}

function clearAuthCookies(res: express.Response): void {
	res.clearCookie(AUTH_ACCESS_COOKIE, authCookieOptions());
	res.clearCookie(AUTH_REFRESH_COOKIE, authCookieOptions());
}

function authCookieOptions(): express.CookieOptions {
	return {
		httpOnly: true,
		path: "/",
		sameSite: env.NODE_ENV === "dev" ? "none" : "lax",
		secure: true,
	};
}

function getCookie(req: express.Request, name: string): string | null {
	const header = req.headers.cookie;
	if (!header) return null;
	for (const cookie of header.split(";")) {
		const [rawName, ...rawValue] = cookie.trim().split("=");
		if (rawName === name) {
			return decodeURIComponent(rawValue.join("="));
		}
	}
	return null;
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
