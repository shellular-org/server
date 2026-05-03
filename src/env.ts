import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
	HOST: z.string().default("0.0.0.0"),
	PORT: z.string().transform(Number).default(6969),
	CORS_ORIGIN: z.string().min(1).default("*"),
	NODE_ENV: z.enum(["dev", "prod"]),
	CONTACT_EMAIL: z.email().default("team@shellular.dev"),
});

export const env = envSchema.parse(process.env);
