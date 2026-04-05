import { env } from "env";
import type { NextFunction, Request, Response } from "express";

export default function cors(req: Request, res: Response, next: NextFunction) {
	res.header("Access-Control-Allow-Origin", env.CORS_ORIGIN);
	res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
	res.header(
		"Access-Control-Allow-Headers",
		"Origin, Content-Type, Accept, x-auth-token",
	);

	if (req.method === "OPTIONS") {
		res.sendStatus(200);
		return;
	}

	next();
}
