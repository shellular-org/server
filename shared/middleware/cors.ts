import type { NextFunction, Request, Response } from "express";

import { sharedEnv } from "../env";

const allowedOrigins = new Set(sharedEnv.CORS_ORIGIN);
const allowAll = allowedOrigins.has("*");
const fallbackOrigin = sharedEnv.CORS_ORIGIN[0];

export default function cors(req: Request, res: Response, next: NextFunction) {
  const requestOrigin = req.headers.origin;

  if (allowAll) {
    res.header("Access-Control-Allow-Origin", "*");
  } else if (requestOrigin && allowedOrigins.has(requestOrigin)) {
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
