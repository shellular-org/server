import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { PROJECT_ROOT_DIR } from "@shared/config";
import { LocalCache } from "@shared/local-cache";
import { logger } from "@shared/logger";
import { z } from "zod";

/**
 * Notices are short, dismiss-once messages shown in the app (e.g. on the home
 * screen). They live in a plain JSON file (see NOTICES_FILE) that is managed
 * with the `notices` CLI (scripts/notices.ts). The server reads that file into
 * memory and re-reads it once the cached copy expires, so edits to the file
 * show up in the app without a redeploy or restart.
 *
 * Each notice has a stable `id`. The app remembers which ids a user has
 * dismissed, so bumping the file with a brand-new id is how you push a fresh
 * popup to everyone.
 */

export const NoticeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  // ISO timestamp. Used only for ordering / bookkeeping; the app relies on `id`.
  createdAt: z.string().min(1),
});

export type Notice = z.infer<typeof NoticeSchema>;

const NoticesFileSchema = z.object({
  notices: z.array(NoticeSchema).default([]),
});

// content/notices.json, resolved from the project root (one level up from src).
export const NOTICES_FILE = join(PROJECT_ROOT_DIR, "content", "notices.json");

// Re-read the notices file this often so edits propagate without a restart.
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_KEY = "notices";

const cache = new LocalCache<Notice[]>({ ttlMs: REFRESH_INTERVAL_MS });

// Last successfully-read notices. Used as a fallback when a re-read fails (e.g.
// a malformed edit) so a bad file never blanks out the endpoint.
let lastGood: Notice[] = [];

async function readNoticesFile(): Promise<Notice[]> {
  const raw = await readFile(NOTICES_FILE, "utf8");
  const parsed = NoticesFileSchema.parse(JSON.parse(raw));
  return parsed.notices;
}

/**
 * Returns the notices, reading from disk when the cache is cold or expired.
 * Concurrent callers share one read (handled by the cache). On read failure the
 * last good value is returned, so a malformed edit never takes the endpoint down.
 */
export async function getNotices(): Promise<Notice[]> {
  const notices = await cache.getOrFetch(CACHE_KEY, async () => {
    try {
      const fresh = await readNoticesFile();
      lastGood = fresh;
      logger.info(`Loaded ${fresh.length} notice(s) from disk.`);
      return fresh;
    } catch (err) {
      logger.error("Failed to load notices file, keeping previous cache:", err);
      // Returning undefined leaves the cache untouched; fall back below.
      return undefined;
    }
  });

  return notices ?? lastGood;
}

/** Warm the cache on boot so the first request doesn't pay the disk read. */
export async function initNotices(): Promise<void> {
  await getNotices();
}
