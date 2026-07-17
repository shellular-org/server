import { ForbiddenError } from "@shared/http-error";
import type { NextFunction, Request, Response } from "express";

export const HOST_USER_AGENT_REGEX = /^shellular\/\d+\.\d+\.\d+$/;

/**
 *
 * @param allowedPatterns A list of allowed user agent patterns.
 * @param errorMsg The error message to return when the user agent is not allowed.
 * @returns
 */
export function userAgentFilter(
  allowedPatterns: RegExp[] = [],
  errorMsg = "Invalid request",
) {
  if (allowedPatterns.length === 0) {
    throw new Error("allowedPatterns cannot be empty");
  }

  return function userAgentMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ) {
    const userAgent = req.headers["user-agent"] || "";

    const isAllowed = allowedPatterns.some((regex) => regex.test(userAgent));

    if (!isAllowed) {
      throw new ForbiddenError(errorMsg);
    }

    next();
  };
}
