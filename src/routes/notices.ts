import { Router } from "express";

import { getNotices } from "@/notices";

export const router = Router();

// Public: the app fetches this to decide whether to show a notice popup.
// Cached in memory server-side; safe to hit frequently.
router.get("/notices", async (_req, res) => {
	res.setHeader("Cache-Control", "public, max-age=300");
	res.json({ notices: await getNotices() });
});
