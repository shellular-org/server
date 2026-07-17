import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

/**
 * Environment shared by BOTH central server and regional relays. This is the base
 * the side-specific env schemas extend, and the *only* env that modules living in
 * `shared/` (logger, ticket secret) are allowed to read — nothing in the codebase
 * should touch `process.env.<X>` directly.
 *
 * It deliberately validates ONLY the truly-shared vars. A relay must be able to
 * boot without central's OAuth/DB config, and central without relay-only config,
 * so neither side's requirements can leak in here.
 */
const CORS_ORIGIN_DEFAULT = [
  "https://app.shellular.dev", // web app
  "shellular://", // android app
  "shellular://localhost", // iOS app
];

export const sharedEnvSchema = z.object({
  NODE_ENV: z.enum(["dev", "prod"]).default("prod"),
  /** HMAC secret for signing (central) and verifying (relay) WebSocket tickets. */
  WS_TOKEN_SECRET: z.string().min(32),
  CONTACT_EMAIL: z.email().default("team@shellular.dev"),
  /** Allowed CORS origins (comma-separated), used by the shared cors middleware. */
  CORS_ORIGIN: z
    .string()
    .min(1)
    .default(CORS_ORIGIN_DEFAULT.join(","))
    .transform((val) =>
      val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
});

/**
 * Parsed shared env for `shared/` leaf modules that can't extend a schema (they're
 * imported by both sides). Central and relay do their OWN full parse via
 * `sharedEnvSchema.extend(...)`, so this parses only the shared subset and ignores
 * unknown keys — it never fails on a side-specific var being absent.
 */
export const sharedEnv = sharedEnvSchema.parse(process.env);

// using console.log instead of local logger to ensure we don't import any local modules in this file
const nodeEnvLog = `--- NODE_ENV: ${sharedEnv.NODE_ENV} ---`;
console.log("-".repeat(nodeEnvLog.length));
console.log(nodeEnvLog);
console.log("-".repeat(nodeEnvLog.length));
