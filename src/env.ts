import dotenv from "dotenv";
import * as z from "zod";

dotenv.config({ override: true });

const envSchema = z.object({
	HOST: z.string().default("0.0.0.0"),
	PORT: z.string().transform(Number).default(6969),
	CORS_ORIGIN: z.string().default("*"),
});

export const env = envSchema.parse(process.env);
