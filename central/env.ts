import { sharedEnvSchema } from "@shared/env";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

// Central's env = the shared base (NODE_ENV, WS_TOKEN_SECRET, CORS_ORIGIN, …) plus
// central-only config. Extending the shared schema keeps the shared vars validated
// identically on both sides.
const envSchema = sharedEnvSchema.extend({
  CENTRAL_HOST: z.string().default("0.0.0.0"),
  CENTRAL_PORT: z.string().transform(Number).default(6969),
  /**
   * Shared secret authenticating relay→central reports (self-registration and
   * host/client presence).
   */
  RELAY_SECRET: z.string().min(16),
  AUTH_PUBLIC_BASE_URL: z.url().default("https://server.shellular.dev"),
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
