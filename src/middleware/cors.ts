import type { NextFunction, Request, Response } from "express";

import { env } from "@/env";

export default function cors(req: Request, res: Response, next: NextFunction) {
	const requestOrigin = req.headers.origin;
	res.header(
		"Access-Control-Allow-Origin",
		env.NODE_ENV === "dev" && requestOrigin ? requestOrigin : env.CORS_ORIGIN,
	);
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
