import type express from "express";
import { z } from "zod";

import { HttpError } from "../http-error";
import { logger } from "../logger";

/**
 * Shared error + 404 handlers. Express requires these to be registered LAST (after
 * every route), so both central and relay `app.use()` them explicitly at the end of
 * their setup rather than having the factory hide the ordering.
 */

/** Maps thrown errors to the JSON error contract; falls back to 500. */
export function errorHandler(
  err: Error,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction,
): void {
  if (err instanceof z.ZodError) {
    res.status(400).json({ success: false, error: err.message });
    return;
  }

  if (err instanceof HttpError && err.statusCode < 500) {
    res.status(err.statusCode).json({ success: false, error: err.message });
    return;
  }

  logger.error("Internal error:", err);
  res.status(500).json({ success: false, error: "Internal server error" });
}

/** Catch-all for unmatched routes. Register after all real routes. */
export function notFoundHandler(
  _req: express.Request,
  res: express.Response,
): void {
  res.status(404).json({ success: false, message: "Not found" });
}
