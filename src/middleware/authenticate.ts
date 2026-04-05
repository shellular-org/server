import type { NextFunction, Request, Response } from "express";

export default async function authenticate(
	_req: Request,
	_res: Response,
	next: NextFunction,
) {
	next();
}
