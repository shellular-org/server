import { sharedEnvSchema } from "@shared/env";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

/**
 * The regional relay's env = the shared base (NODE_ENV, WS_TOKEN_SECRET) plus the
 * relay-only vars. Deliberately tiny: the relay owns no DB and never needs
 * central's OAuth/DB config, so extending only `sharedEnvSchema` keeps it that way.
 */
const relayEnvSchema = sharedEnvSchema
  .extend({
    RELAY_HOST: z.string().default("0.0.0.0"),
    RELAY_PORT: z.string().transform(Number).default(6970),
    /**
     * The public HTTP(S) origin clients reach this relay at, e.g.
     * https://in.shellular.dev. This is the relay's sole identity in central's
     * live fleet — it self-registers this URL, reports it in presence, and central
     * health-checks it. It's an HTTP url (not ws): central/CLI hit `/health` over
     * HTTP, and the CLI derives the WebSocket protocol from it (http→ws, https→wss).
     *
     * Optional in the schema because in dev it's derived from RELAY_HOST/PORT (see
     * the transform below); in prod it is REQUIRED and must be https.
     */
    RELAY_PUBLIC_URL: z.url().optional(),
    /** Central API base URL, e.g. https://server.shellular.dev — for register/presence. */
    CENTRAL_API_URL: z.url(),
    /** Shared secret authenticating register + presence reports to central. */
    RELAY_SECRET: z.string().min(16),
    POSTHOG_KEY: z.string().optional(),
    POSTHOG_HOST: z.url().default("https://us.i.posthog.com"),
  })
  .transform((env, ctx) => {
    let publicUrl = env.RELAY_PUBLIC_URL;

    if (!publicUrl) {
      if (env.NODE_ENV === "dev") {
        // Minimal-dotenv dev: derive from the bind host/port over plain HTTP.
        publicUrl = `http://${env.RELAY_HOST}:${env.RELAY_PORT}`;
      } else {
        ctx.addIssue({
          code: "custom",
          path: ["RELAY_PUBLIC_URL"],
          message: "RELAY_PUBLIC_URL is required in production.",
        });
        return z.NEVER;
      }
    } else if (env.NODE_ENV !== "dev" && !publicUrl.startsWith("https://")) {
      // A plaintext relay URL in production is a misconfiguration.
      ctx.addIssue({
        code: "custom",
        path: ["RELAY_PUBLIC_URL"],
        message: "RELAY_PUBLIC_URL must be https in production.",
      });
      return z.NEVER;
    }

    return { ...env, RELAY_PUBLIC_URL: publicUrl };
  });

export const relayEnv = relayEnvSchema.parse(process.env);
