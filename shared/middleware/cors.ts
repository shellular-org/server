import type { NextFunction, Request, Response } from "express";

import { sharedEnv } from "../env";

const allowedOrigins = new Set(sharedEnv.CORS_ORIGIN);
console.log("CORS_ORIGIN:", Array.from(allowedOrigins).join(", "));
const allowAll = allowedOrigins.has("*");
const fallbackOrigin = sharedEnv.CORS_ORIGIN[0];

export default function cors(req: Request, res: Response, next: NextFunction) {
  const requestOrigin = req.headers.origin;

  // we cannot send "*" as the Access-Control-Allow-Origin header if credentials are allowed
  // (which are) in the frontend, so we must echo back the request origin if it's allowed
  if (allowAll || (requestOrigin && allowedOrigins.has(requestOrigin))) {
    res.header("Access-Control-Allow-Origin", requestOrigin);
  } else if (sharedEnv.NODE_ENV === "dev" && requestOrigin) {
    res.header("Access-Control-Allow-Origin", requestOrigin);
  } else {
    res.header("Access-Control-Allow-Origin", fallbackOrigin);
  }
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, Content-Type, Accept, Authorization, x-auth-token",
  );
  res.header("Vary", "Origin");

  if (req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }

  next();
}
