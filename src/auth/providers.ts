import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as arctic from "arctic";

import { env } from "@/env";
import { BadRequestError } from "@/error/http";
import {
	type AuthProvider,
	consumeLoginState,
	type LoginState,
	type ProviderProfile,
	saveLoginState,
} from "./store";

const PROVIDERS = ["google", "github", "apple"] as const;
const APPLE_PRIVATE_KEY_FILE = "apple_key.p8";

type ProviderStatus = {
	id: AuthProvider;
	enabled: boolean;
};

type AppleUser = {
	name?: {
		firstName?: string;
		lastName?: string;
	};
	email?: string;
};

export function listProviders(): ProviderStatus[] {
	return PROVIDERS.map((id) => ({ id, enabled: isProviderEnabled(id) }));
}

export function isProviderEnabled(provider: AuthProvider): boolean {
	switch (provider) {
		case "google":
			return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
		case "github":
			return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
		case "apple":
			return Boolean(
				env.APPLE_CLIENT_ID &&
					env.APPLE_TEAM_ID &&
					env.APPLE_KEY_ID &&
					hasApplePrivateKey(),
			);
	}
}

export function assertProvider(value: string): AuthProvider {
	if (PROVIDERS.includes(value as AuthProvider)) {
		return value as AuthProvider;
	}
	throw new BadRequestError("Unsupported OAuth provider.");
}

export function createAuthorizationUrl(provider: AuthProvider): string {
	return createOAuthAuthorizationUrl(provider);
}

export function createLinkAuthorizationUrl(
	provider: AuthProvider,
	userId: string,
): string {
	return createOAuthAuthorizationUrl(provider, { purpose: "link", userId });
}

function createOAuthAuthorizationUrl(
	provider: AuthProvider,
	options: { purpose?: LoginState["purpose"]; userId?: string } = {},
): string {
	ensureProviderEnabled(provider);
	const state = arctic.generateState();

	if (provider === "google") {
		const codeVerifier = arctic.generateCodeVerifier();
		saveLoginState(state, provider, {
			codeVerifier,
			purpose: options.purpose,
			userId: options.userId,
		});
		return getGoogle()
			.createAuthorizationURL(state, codeVerifier, [
				"openid",
				"profile",
				"email",
			])
			.toString();
	}

	saveLoginState(state, provider, {
		purpose: options.purpose,
		userId: options.userId,
	});
	if (provider === "github") {
		return getGitHub()
			.createAuthorizationURL(state, ["read:user", "user:email"])
			.toString();
	}

	const url = getApple().createAuthorizationURL(state, ["name", "email"]);
	url.searchParams.set("response_mode", "form_post");
	return url.toString();
}

type ProviderCallbackResult = {
	profile: ProviderProfile;
	loginState: LoginState;
};

export async function getProfileFromCallback(
	provider: AuthProvider,
	code: string,
	state: string,
	appleUser?: string,
): Promise<ProviderCallbackResult> {
	ensureProviderEnabled(provider);
	const loginState = consumeLoginState(state, provider);

	if (provider === "google") {
		if (!loginState.codeVerifier) {
			throw new BadRequestError("Invalid sign-in request.");
		}
		const tokens = await getGoogle().validateAuthorizationCode(
			code,
			loginState.codeVerifier,
		);
		const claims = arctic.decodeIdToken(tokens.idToken()) as Record<
			string,
			unknown
		>;
		return {
			loginState,
			profile: {
				provider,
				providerAccountId: String(claims.sub ?? ""),
				email: String(claims.email ?? ""),
				emailVerified: claims.email_verified === true,
				name: asString(claims.name),
				avatarUrl: asString(claims.picture),
			},
		};
	}

	if (provider === "github") {
		const tokens = await getGitHub().validateAuthorizationCode(code);
		const accessToken = tokens.accessToken();
		const [userResp, emailResp] = await Promise.all([
			fetch("https://api.github.com/user", {
				headers: githubHeaders(accessToken),
			}),
			fetch("https://api.github.com/user/emails", {
				headers: githubHeaders(accessToken),
			}),
		]);

		if (!userResp.ok || !emailResp.ok) {
			throw new BadRequestError("GitHub did not return account details.");
		}

		const user = (await userResp.json()) as Record<string, unknown>;
		const emails = (await emailResp.json()) as Array<Record<string, unknown>>;
		const primary =
			emails.find(
				(email) => email.primary === true && email.verified === true,
			) ?? emails.find((email) => email.verified === true);

		return {
			loginState,
			profile: {
				provider,
				providerAccountId: String(user.id ?? ""),
				email: String(primary?.email ?? ""),
				emailVerified: Boolean(primary),
				name: asString(user.name) ?? asString(user.login),
				avatarUrl: asString(user.avatar_url),
			},
		};
	}

	const tokens = await getApple().validateAuthorizationCode(code);
	const claims = arctic.decodeIdToken(tokens.idToken()) as Record<
		string,
		unknown
	>;
	const parsedAppleUser = parseAppleUser(appleUser);
	const name = [
		parsedAppleUser?.name?.firstName,
		parsedAppleUser?.name?.lastName,
	]
		.filter(Boolean)
		.join(" ");

	return {
		loginState,
		profile: {
			provider,
			providerAccountId: String(claims.sub ?? ""),
			email: String(claims.email ?? parsedAppleUser?.email ?? ""),
			emailVerified:
				claims.email_verified === true || claims.email_verified === "true",
			name: name || null,
			avatarUrl: null,
		},
	};
}

function getGoogle() {
	return new arctic.Google(
		required(env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID"),
		required(env.GOOGLE_CLIENT_SECRET, "GOOGLE_CLIENT_SECRET"),
		callbackUrl("google"),
	);
}

function getGitHub() {
	return new arctic.GitHub(
		required(env.GITHUB_CLIENT_ID, "GITHUB_CLIENT_ID"),
		required(env.GITHUB_CLIENT_SECRET, "GITHUB_CLIENT_SECRET"),
		callbackUrl("github"),
	);
}

function getApple() {
	return new arctic.Apple(
		required(env.APPLE_CLIENT_ID, "APPLE_CLIENT_ID"),
		required(env.APPLE_TEAM_ID, "APPLE_TEAM_ID"),
		required(env.APPLE_KEY_ID, "APPLE_KEY_ID"),
		parseApplePrivateKey(getApplePrivateKey()),
		callbackUrl("apple"),
	);
}

function callbackUrl(provider: AuthProvider): string {
	return new URL(
		`/auth/oauth/${provider}/callback`,
		env.AUTH_PUBLIC_BASE_URL,
	).toString();
}

function ensureProviderEnabled(provider: AuthProvider): void {
	if (!isProviderEnabled(provider)) {
		throw new BadRequestError("This sign-in provider is not configured.");
	}
}

function required(value: string | undefined, name: string): string {
	if (!value) throw new Error(`Missing ${name}`);
	return value;
}

function getApplePrivateKey(): string {
	const path = applePrivateKeyFilePath();
	if (!existsSync(path)) {
		throw new Error(`Apple private key file not found: ${path}`);
	}
	return readFileSync(path, "utf8");
}

function hasApplePrivateKey(): boolean {
	return existsSync(applePrivateKeyFilePath());
}

function applePrivateKeyFilePath(): string {
	return resolve(__dirname, "..", "..", APPLE_PRIVATE_KEY_FILE);
}

function parseApplePrivateKey(value: string): Uint8Array {
	const normalized = value.replace(/\\n/g, "\n");
	const base64 = normalized
		.replace("-----BEGIN PRIVATE KEY-----", "")
		.replace("-----END PRIVATE KEY-----", "")
		.replace(/\s/g, "");
	return new Uint8Array(Buffer.from(base64, "base64"));
}

function parseAppleUser(value?: string): AppleUser | null {
	if (!value) return null;
	try {
		return JSON.parse(value) as AppleUser;
	} catch {
		return null;
	}
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}

function githubHeaders(accessToken: string): HeadersInit {
	return {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${accessToken}`,
		"User-Agent": "Shellular",
	};
}
