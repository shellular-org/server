import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
	HOST: z.string().default("0.0.0.0"),
	PORT: z.string().transform(Number).default(6969),
	CORS_ORIGIN: z.string().min(1).default("*"),
	NODE_ENV: z.enum(["dev", "prod"]),
	// Google Sheets integration (optional — skipped if not set)
	WAITLIST_GOOGLE_SHEET_ID: z.string().optional(),
});

export const env = envSchema.parse(process.env);
