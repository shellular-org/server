import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
	HOST: z.string().default("0.0.0.0"),
	PORT: z.string().transform(Number).default(6969),
	CORS_ORIGIN: z
		.string()
		.min(1)
		.default("https://app.shellular.dev, shellular://, shellular://localhost")
		.transform((val) =>
			val
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
		),
	NODE_ENV: z.enum(["dev", "prod"]),
	CONTACT_EMAIL: z.email().default("team@shellular.dev"),
	WS_TOKEN_SECRET: z.string().min(32),
	POSTHOG_KEY: z.string().min(1).optional(),
	POSTHOG_HOST: z.url().default("https://us.i.posthog.com"),
	AUTH_PUBLIC_BASE_URL: z.url().default("https://api.shellular.dev"),
	AUTH_APP_CALLBACK_URL: z.string().default("shellular://auth-callback"),
	GOOGLE_CLIENT_ID: z.string().optional(),
	GOOGLE_CLIENT_SECRET: z.string().optional(),
	GITHUB_CLIENT_ID: z.string().optional(),
	GITHUB_CLIENT_SECRET: z.string().optional(),
	APPLE_CLIENT_ID: z.string().optional(),
	APPLE_TEAM_ID: z.string().optional(),
	APPLE_KEY_ID: z.string().optional(),
});

export const env = envSchema.parse(process.env);

console.log(env.CORS_ORIGIN);

// using console.log instead of local logger to ensure we don't import any local modules in this file
const nodeEnvLog = `--- NODE_ENV: ${env.NODE_ENV} ---`;
console.log("-".repeat(nodeEnvLog.length));
console.log(nodeEnvLog);
console.log("-".repeat(nodeEnvLog.length));
