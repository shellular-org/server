import { google } from "googleapis";

import { markWaitlistSheetsFailed } from "@/db";
import { env } from "@/env";
import { logger } from "@/logger";

// ─── Google Sheets helper ─────────────────────────────────
export async function appendWaitlistToSheet(entry: {
	name: string;
	email: string;
	social: string;
	platforms: string;
}) {
	const { name, email, social, platforms } = entry;
	if (!env.WAITLIST_GOOGLE_SHEET_ID) {
		return;
	}

	try {
		const auth = new google.auth.GoogleAuth({
			keyFile: "credentials.json",
			scopes: ["https://www.googleapis.com/auth/spreadsheets"],
		});
		const sheets = google.sheets({ version: "v4", auth });
		await sheets.spreadsheets.values.append({
			spreadsheetId: env.WAITLIST_GOOGLE_SHEET_ID,
			range: "Sheet1!A:D",
			valueInputOption: "RAW",
			requestBody: {
				values: [
					[
						name,
						email,
						social,
						platforms,
						new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
					],
				],
			},
		});
	} catch (err) {
		logger.error("Google Sheets append failed:", err);
		markWaitlistSheetsFailed(email);
	}
}
